'use strict'

const filedisk = require('file-disk')
const http = require('http')
//const archiver = require('archiver')
//const JSZip = require('jszip')

const STATE_READ_DISK_SIZE = -1
const STATE_READ_OFFSET = 0
const STATE_READ_SIZE = 1
const STATE_READ_DATA = 2

class HttpDisk extends filedisk.Disk {
	constructor(url) {
		super(true, true, false, true)
		this.url = url
	}
	_getCapacity(callback) {
		callback(this.capacity)
	}
	_read(buffer, bufferOffset, length, fileOffset, callback) {
		buffer.fill(0, bufferOffset, bufferOffset + length)
		callback(null, length, buffer)
	}
	_write(buffer, bufferOffset, length, fileOffset, callback) {
		callback(null, length)
	}
	_flush(callback) {
		callback(null)
	}
	_discard(offset, length, callback) {
		callback(null)
	}
	setCapacity(capacity) {
		this.capacity = capacity
	}
	getBuffers() {
		const buffers = []
		let lastEnd = 0
		this.knownChunks.forEach((chunk) => {
			if (chunk.start > lastEnd) {
				buffers.push(Buffer.alloc(chunk.start - lastEnd))
			}
			buffers.push(chunk.buffer)
			lastEnd = chunk.end + 1
		})
		if (this.capacity > lastEnd) {
			buffers.push(Buffer.alloc(this.capacity - lastEnd))
		}
		return buffers
	}
	getBlob() {
		return new Blob(this.getBuffers())
	}
	getFile() {
		return new File(this.getBuffers(), 'resin.img', { type: 'application/x-raw-disk-image' })
	}
	//getZippedFile(callback) {
	//	const zip = new JSZip()
	//	//zip.file('resin.img', 'tralala')
	//	zip.file('resin.img', this.getBlob())
	//	console.log('iiiii')
	//	return zip.generateAsync({ type: 'blob' })
	//	.then((content) => {
	//		console.log('iiiiix', content)
	//		callback(content)
	//	})
	//	//const chunks = []
	//	//archive.on('data', (chunk) => {
	//	//	chunks.push(chunk)
	//	//})
	//	//archive.on('end', () => {
	//	//	callback(new File(chunks, 'resin.img', { type: 'application/x-raw-disk-image' }))
	//	//})
	//	//const buf = Buffer.concat(this.getBuffers())
	//	//archive.append(buf, { name: 'resin.img' })
	//	//archive.finalize()
	//}
}

const bufferToStream = (buffer) => {
	  let stream = new Duplex();
	  stream.push(buffer);
	  stream.push(null);
	  return stream;
}

let state = STATE_READ_DISK_SIZE
let offset, size
const buffers = []
const disk = new HttpDisk('')

const sum = (numbers) => {
	return numbers.reduce((a, b) => a + b, 0)
}

const uint8ArrayToNumber = (array) => {
	return sum(Array.from(array).map((value, index) => value * Math.pow(256, index)))
}

const read = (length) => {
	if (sum(buffers.map(b => b.length)) < length) {
		return
	}
	const result = []
	const total = length
	let buf
	for (let i = 0; i < buffers.length; i++) {
		buf = buffers[i]
		if (buf.length <= length) {
			result.push(buf)
			buffers.shift()
			i--
			length -= buf.length
			if (length === 0) {
				break
			}
		} else {
			result.push(buf.slice(0, length))
			buffers[i] = buf.slice(length)
			break
		}
	}
	return Buffer.concat(result, total)
}

const updateState = () => {
	state = (state + 1) % 3
}

const sizeToRead = () => {
	if ((state === STATE_READ_DISK_SIZE) || (state === STATE_READ_OFFSET) || (state === STATE_READ_SIZE)) {
		return 8
	} else {
		return size
	}
}

const proceed = () => {
	while (true) {
		let toRead = sizeToRead()
		let data = read(toRead)
		if (data === undefined) {
			return
		}
		if (state === STATE_READ_DISK_SIZE) {
			const diskSize = uint8ArrayToNumber(data)
			disk.setCapacity(diskSize)
			console.log('disk size is', diskSize)
		} else if (state === STATE_READ_OFFSET) {
			offset = uint8ArrayToNumber(data)
		} else if (state === STATE_READ_SIZE) {
			size = uint8ArrayToNumber(data)
		} else if (state === STATE_READ_DATA) {
			disk.write(data, 0, size, offset, (err, bytesWritten) => {
				//console.log('done', err, bytesWritten)
			})
			//console.log('gonna write', size, 'bytes at offset', offset, 'data length is', data.length)
		}
		updateState()
	}
}

http.get({ host: location.hostname, port: location.port, path: '/data' }, (response) => {
	response.on('data', (d) => {
		console.log('on data', d.length, typeof d, d)
		buffers.push(d)
		proceed()
	})
	response.on('error', (e) => {
		console.log('on error', e)
	})
	response.on('end', () => {
		console.log('end')
		const url = URL.createObjectURL(disk.getFile())
		//const url = URL.createObjectURL(disk.getBlob())
		//disk.getZippedFile((file) => {
		//	console.log('wat', file)
		//	window.open(URL.createObjectURL(url))
		//})
		console.log('file url is', url)
		document.body.innerHTML = `<a href="${url}">Click here to download the image</a>`
		window.open(url)
	})
})
