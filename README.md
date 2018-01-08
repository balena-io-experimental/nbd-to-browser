Run it
======
 * Update the docker registry credentials in `registry-data/config.yml` on the 2 last lines.
 * Start a docker registry proxy

`docker run -d --restart=always -p 5000:5000 --name v2-mirror -v $(pwd)/registry-data:/var/lib/registry registry:2 /var/lib/registry/config.yml`

 * Set your `GOPATH`

`export GOPATH="/path/to/your/gopath`

 * Build and run

`./go.sh`

 * Open http://0.0.0.0:8080 in Firefox


Limitations
===========

 * The created image is not complete
 * The image size is hardcoded
 * The server will crash if it gets 2 concurrent requests
 * Only Firefox can download >2GiB blobs
