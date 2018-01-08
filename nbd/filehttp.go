package nbd

import (
	"golang.org/x/net/context"
	"os"
	"io/ioutil"
	"encoding/binary"
)

var Backends map[string]*FileHttpBackend

func init() {
	Backends = make(map[string]*FileHttpBackend)
}

// FileHttpBackend implements Backend
type FileHttpBackend struct {
	file *os.File
	Size uint64
	Channel chan []byte
	End chan bool
}

// WriteAt implements Backend.WriteAt
func (fb *FileHttpBackend) WriteAt(ctx context.Context, b []byte, offset int64, fua bool) (int, error) {
	fb.Channel <- Uint64ToBytes(uint64(offset))
	fb.Channel <- Uint64ToBytes(uint64(len(b)))
	fb.Channel <- b
	n, err := fb.file.WriteAt(b, offset)
	if err != nil || !fua {
		return n, err
	}
	err = fb.file.Sync()
	if err != nil {
		return 0, err
	}
	return n, err
}

// ReadAt implements Backend.ReadAt
func (fb *FileHttpBackend) ReadAt(ctx context.Context, b []byte, offset int64) (int, error) {
	return fb.file.ReadAt(b, offset)
}

// TrimAt implements Backend.TrimAt
func (fb *FileHttpBackend) TrimAt(ctx context.Context, length int, offset int64) (int, error) {
	return length, nil
}

// Flush implements Backend.Flush
func (fb *FileHttpBackend) Flush(ctx context.Context) error {
	return nil
}

// Close implements Backend.Close
func (fb *FileHttpBackend) Close(ctx context.Context) error {
	fb.End <- true
	defer func() {
		os.Remove(fb.file.Name())
	}()
	return fb.file.Close()
}

// Size implements Backend.Size
func (fb *FileHttpBackend) Geometry(ctx context.Context) (uint64, uint64, uint64, uint64, error) {
	return fb.Size, 1, 32 * 1024, 128 * 1024 * 1024, nil
}

// Size implements Backend.HasFua
func (fb *FileHttpBackend) HasFua(ctx context.Context) bool {
	return true
}

// Size implements Backend.HasFua
func (fb *FileHttpBackend) HasFlush(ctx context.Context) bool {
	return true
}

func Uint64ToBytes(i uint64) []byte {
	bytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(bytes, i)
	return bytes
}

// Generate a new file backend
func NewFileHttpBackend(ctx context.Context, ec *ExportConfig) (Backend, error) {
	file, err := ioutil.TempFile("", "")
	if err != nil {
		return nil, err
	}
	//size := 2 * 1024 * 1024 * 1024 + 1
	size := 3290431488
	os.Truncate(file.Name(), int64(size))
	backend := FileHttpBackend{
		file: file,
		Size: uint64(size),
		Channel : make(chan []byte),
		End: make(chan bool),
	}
	Backends[ec.Name] = &backend
	return &backend, nil
}

// Register our backend
func init() {
	RegisterBackend("filehttp", NewFileHttpBackend)
}
