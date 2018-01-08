all: static/bundle.js gonbdserver

client/node_modules: client/package.json
	cd client; npm i

static/bundle.js: client/index.js client/node_modules
	./client/node_modules/.bin/browserify client/index.js -o static/bundle.js

gonbdserver: main.go nbd/*.go
	go get
	go build

create-image/node_modules: create-image/package.json
	cd create-image; npm i

clean:
	rm -rf client/node_modules create-image/node-modules static/bundle.js gonbdserver
