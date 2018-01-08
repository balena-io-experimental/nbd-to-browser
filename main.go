package main

import (
	"github.com/abligh/gonbdserver/nbd"
	"golang.org/x/net/context"
	"sync"
	"net/http"
	"log"
	"io/ioutil"
	"os"
	"os/exec"
	"encoding/binary"
	"compress/gzip"
)

const ADDRESS = "0.0.0.0:8080"

var logger *log.Logger
var listener *nbd.Listener
var socket *os.File

func Uint64ToBytes(i uint64) []byte {
	bytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(bytes, i)
	return bytes
}

func init() {
	logger = log.New(os.Stdout, "", 0)
	var exports = make([]nbd.ExportConfig, 0, 255)
	var tls_config nbd.TlsConfig
	var err error
	socket, err = ioutil.TempFile("", "")
	if err != nil {
		logger.Fatal(err)
	}
	defer func() {
		socket.Close()
		os.Remove(socket.Name())
	}()
	server_config := nbd.ServerConfig {
		Protocol: "unix",
		Address: socket.Name(),
		Exports: exports,
		Tls: tls_config,
		DisableNoZeroes: false,
	}
	listener, err = nbd.NewListener(logger, server_config)
	if err != nil {
		logger.Printf("[ERROR] Could not create listener for %s:%s: %v", server_config.Protocol, server_config.Address, err)
		return
	}
}

func add_listener() string {
	name := "name1"
	var export = nbd.ExportConfig {
		Name: name,
		Driver: "filehttp",
		Workers: 1,
		MinimumBlockSize: 0,
		PreferredBlockSize: 0,
		MaximumBlockSize: 0,
	}
	listener.Exports = listener.Exports[0:1]
	listener.Exports[0] = export
	return name
}

func main() {
	var sessionWaitGroup sync.WaitGroup
	ctx, configCancelFunc := context.WithCancel(context.Background())
	defer func() {
		configCancelFunc()
	}()
	go func() {
		listener.Listen(ctx, ctx, &sessionWaitGroup)
	}()
	logger.Printf("Please visit http://%s", ADDRESS)
	start_http_server()
}

func run(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if err != nil {
		logger.Printf("%s failed", name)
		logger.Fatal(err)
	}
}

func data(w http.ResponseWriter, r *http.Request) {
	device := "/dev/nbd0"
	name := add_listener()
	run("nbd-client", "-name", name, "-u", socket.Name(), device)
	fb := nbd.Backends[name]
	logger.Printf("gruik %s, %x", name, fb)
	go func() {
		run("create-image/index.js", device)
		//run("mkfs.ext4", device)
		run("nbd-client", "-d", device)
	}()
	var bytes []byte
	gz := gzip.NewWriter(w)
	defer gz.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	gz.Write(Uint64ToBytes(fb.Size))
	for {
		select {
		case bytes = <-fb.Channel:
			gz.Write(bytes)
		case <-fb.End:
			return
		}
	}
}

func start_http_server() {
	static := http.FileServer(http.Dir("static"))
	http.Handle("/", static)
	http.HandleFunc("/data", data)
	http.ListenAndServe(ADDRESS, nil)
}
