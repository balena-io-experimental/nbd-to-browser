#!/usr/bin/env node

const Promise = require('bluebird')

const _ = require('lodash')
const cp = Promise.promisifyAll(require('child_process'))
const Docker = require('dockerode')
const fs = Promise.promisifyAll(require('fs'))
const tmp = Promise.promisifyAll(require('tmp'))

const SECTOR_SIZE = 512  // bytes
const MiB = Math.pow(1024, 2)

const DEFINITION = require('./definition.json')

const openDisposer = (path, flags, mode) => {
	return fs.openAsync(path, flags, mode)
	.disposer((fd) => {
		return fs.closeAsync(fd)
	})
}

const losetupDisposer = (image) => {
	return cp.execFileAsync('losetup', [ '-P', '--show', '-f', image ])
	.then((stdout) => {
		return stdout.trim()
	})
	.disposer((device) => {
		console.log('losetup -d', device)
		return cp.execFileAsync('losetup', [ '-d', device ])
	})
}

const tmpFileDisposer = () => {
	return tmp.fileAsync({ discardDescriptor: true })
	.disposer((path) => {
		console.log('dispose', path)
		return fs.unlinkAsync(path)
		.catchReturn()
	})
}

const tmpDirDisposer = () => {
	return tmp.dirAsync()
	.disposer((path) => {
		return fs.rmdirAsync(path)
	})
}

const mountDisposer = (device, mountpoint) => {
	return cp.execFileAsync('mount', [ device, mountpoint ])
	.return(mountpoint)
	.disposer(() => {
		console.log('umount', device)
		return cp.execFileAsync('umount', [ mountpoint ])
	})
}

const tmpMountDisposer = (device) => {
	return composeDisposers(tmpDirDisposer(), (mountpoint) => {
		return mountDisposer(device, mountpoint)
	})
}

const waitUntilDockerdIsReady = (docker) => {
	return docker.ping()
	.catch((e) => {
		console.log('waiting for docker', e)
		return Promise.delay(1000)
		.then(() => {
			return waitUntilDockerdIsReady(docker)
		})
	})
}

const composeDisposers = async (outerDisposers, createInnerDisposer) => {
	outerDisposers = await Promise.resolve(outerDisposers)
	if (!Array.isArray(outerDisposers)) {
		outerDisposers = [ outerDisposers ]
	}
	const outerResults = await Promise.map(outerDisposers, (d) => d._promise)
	let innerDisposer, innerResult
	try {
		innerDisposer = await Promise.resolve(createInnerDisposer(...outerResults))
		innerResult = await innerDisposer._promise
	} catch(err) {
		outerDisposers.forEach((d, index) => {
			d._data(outerResults[index])
		})
		throw err
	}
	return Promise.resolve(innerResult).disposer(async innerResult => {
		await innerDisposer._data(innerResult)
		await Promise.map(outerDisposers, (d, index) => d._data(outerResults[index]))
	})
}

const dockerdDisposer = (storageDriver, dataRoot) => {
	return composeDisposers(
		[ tmpFileDisposer(), tmpFileDisposer() ],
		(socket, pidfile) => {
			const dockerd = cp.execFile(
				'dockerd',
				[
					'--storage-driver', storageDriver,
					'--graph', dataRoot,
					'--host', `unix://${socket}`,
					'--pidfile', pidfile,
					'--registry-mirror', 'http://0.0.0.0:5000'
				]
			)
			const docker = new Docker({ socketPath: socket, Promise })
			return waitUntilDockerdIsReady(docker)
			.return(docker)
			.disposer(() => {
				return new Promise((resolve, reject) => {
					dockerd.on('exit', resolve)
					dockerd.on('error', reject)
					dockerd.kill()
				})
			})
		}
	)
}

const createDirectories = (mountpoint) => {
//	/
//	├── current  -> /hostapps/f76eac0fa14f
//	├── counter
//	├── balena
//	│   ├── auf
//	│   ├── containers
//	│   │   └── f76eac0fa14f
//	│   ├── image
//	│   ├── network
//	│   └── volumes
//	│       └── 7a7a0f3960
//	│           └── init
//	├── hostapps
//	│   └── f76eac0fa14f -> /balena/volumes/7a7a0f3960
//	└── sbin
//		└── init -> /current/init
	const directories = ['balena', 'hostapps', 'sbin']
	return Promise.map(directories, (directory) => {
		return fs.mkdirAsync(`${mountpoint}/${directory}`)
		.catchReturn()
	})
}

const createLinks = async (mountpoint, containerId, volumeId) => {
	const hostAppDir = `${mountpoint}/hostapps/${containerId}`
	await fs.mkdirAsync(hostAppDir)
	await fs.symlinkAsync(`/balena/volumes/${volumeId}/_data`, `${hostAppDir}/boot`)
	await fs.symlinkAsync(`/hostapps/${containerId}`, `${mountpoint}/current`)
	await fs.symlinkAsync('/current/init', `${mountpoint}/sbin/init`)
	await fs.writeFileAsync(`${mountpoint}/counter`, '1')
}

const dockerPull = async (docker, image, boot, rootA, rootB) => {
	const stream = await docker.pull(image)
	console.log('boot', boot)
	await new Promise((resolve, reject) => {
		docker.modem.followProgress(
			stream,
			(err, output) => {  // onFinished
				if (err) {
					reject(err)
				} else {
					resolve(output)
				}
			},
			(event) => {  // onProgress
				if (event.progress) {
					console.log(event.progress)
				}
			}
		)
	})
	//const pouet = await cp.execAsync('ls ' + rootA)
	//console.log('pouet', pouet)
	const container = await docker.createContainer({
		Image: image,
		//Cmd: ['/bin/sh'],
		//Cmd: ['/bin/sh', '-c', 'sleep 60 && echo oOKOKOKOKOKOKOKOKOKOKOKOKOKk'],
		Cmd: ['/sbin/init'],
		AttachStdin: true,
		OpenStdin: true,
		Tty: true,
		Volumes: {'/boot': {}},
		HostConfig: {
			Mounts: [
				{
					Source: boot,
					Target: '/mnt/boot',
					Type: 'bind'
				},
				{
					Source: rootA,
					Target: '/mnt/sysroot/active',
					Type: 'bind'
				},
				{
					Source: rootB,
					Target: '/mnt/sysroot/inactive',
					Type: 'bind'
				},
				{
					Source: '/usr/bin/qemu-arm-static',
					Target: '/usr/bin/qemu-arm-static',
					Type: 'bind'
				},
				{
					Source: docker.modem.socketPath,
					Target: '/var/run/docker-host.sock',
					Type: 'bind'
				}
				
			]
		}
	})
	const what = await container.start()
	const data = await container.inspect()
	// TODO: resin-data
	const cmd = `
		cp -r /resin-boot/* /mnt/boot/
		for hook in "/etc/hostapp-update-hooks.d/"*; do
			[ -e "$hook" ] || break
			"$hook" "${data.Id}"
		done
	`
	const exec = await container.exec({
		Cmd: ['/bin/sh', '-c', cmd],
		AttachStdout: true,
		AttachStderr: true
	})
	const execStream = await exec.start()
	container.modem.demuxStream(execStream.output, process.stdout, process.stderr)
	await new Promise((resolve, reject) => {
		execStream.output.on('error', reject)
		execStream.output.on('end', resolve)
	})
	const volume = _.find(data.Mounts, { Type: 'volume' })
	console.log('after2', data.Mounts, volume)
	return {
		volume: volume.Source,
		volumeId: volume.Name,
		containerId: data.Id
	}
}

const PARTITION_TYPES = {
	dos: {
		vfat: 'e',
		ext4: '83'
	},
	gpt: {
		vfat: 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B',
		ext4: '0FC63DAF-8483-4772-8E79-3D69D8477DE4'
	}
}

const createSfdiskScript = () => {
	const partitions = getPartitions()
	const lines = [`label: ${DEFINITION.partitionTableType}`, '']
	const needsAnExtendedPartition = ((partitions.length > 4) && (DEFINITION.partitionTableType ==='dos'))
	let position = toSectors(DEFINITION.firstPartitionOffset)
	partitions.slice(0, 3).forEach((part) => {
		const size = toSectors(part.size)
		let line = `start=${position}, size=${size}, type=${PARTITION_TYPES[DEFINITION.partitionTableType][part.filesystem]}`
		if (DEFINITION.partitionTableType === 'gpt') {
			line += `, name=${part.name}`
		}
		if (part.name === 'resin-boot') {
			line += ', bootable'
		}
		lines.push(line)
		position += size
	})
	if (needsAnExtendedPartition) {
		// Calculate the extended partition size (each logical partition is preceded with 1MiB of free space)
		const size = toSectors(_.sum(_.map(partitions.slice(4), 'size')) + ((partitions.length - 4) * MiB))
		lines.push(`start=${position}, size=${size}, type=f`)
	}
	partitions.slice(3).forEach((part) => {
		const size = toSectors(part.size)
		if (needsAnExtendedPartition) {
			position += toSectors(MiB)
		}
		let line = `start=${position}, size=${size}, type=${PARTITION_TYPES[DEFINITION.partitionTableType][part.filesystem]}`
		if (DEFINITION.partitionTableType === 'gpt') {
			line += `, name=${part.name}`
		}
		if (part.name === 'resin-boot') {
			line += ', bootable'
		}
		lines.push(line)
		position += size
	})
	console.log(lines.join('\n'))
	return lines.join('\n')
}

const runSfdisk = (filePath, sfdiskScript) => {
	const sfdisk = cp.spawn('sfdisk', [ filePath ])
	sfdisk.stderr.pipe(process.stderr)
	sfdisk.stdin.write(sfdiskScript)
	sfdisk.stdin.end()
	return new Promise((resolve, reject) => {
		sfdisk.on('close', (code) => {
			if (code === 0) {
				resolve(code)
			} else {
				reject(code)
			}
		})
	})
}

const createZeroFilledFile = (filePath, size) => {
	return Promise.using(openDisposer(filePath, 'w'), (fd) => {
		return fs.truncateAsync(fd, size)
	})
}

const createPartitionTable = (device) => {
	return runSfdisk(device, createSfdiskScript())
}

const partitionPosition = (index) => {
	// For MBR ('dos') partition tables, there is an extra extended partition (position 4)
	return index + (((index <= 2) || (DEFINITION.partitionTableType === 'gpt')) ? 1 : 2)
}

const getPartition = (name) => {
	const index = _.findIndex(DEFINITION.partitions, { name })
	return _.assign({}, DEFINITION.partitions[index], { position: partitionPosition(index) })
}

const getPartitions = () => {
	return DEFINITION.partitions.map((part, index) => {
		return _.assign({}, part, { position: partitionPosition(index) })
	})
}

MKFS_LABEL_OPTIONS = {
	vfat: '-n',
	ext4: '-L'
}

const formatPartitions = (device) => {
	return Promise.map(getPartitions(), (info) => {
		return cp.execFileAsync(
			`mkfs.${info.filesystem}`,
			[ `${device}p${info.position}`, MKFS_LABEL_OPTIONS[info.filesystem], info.name ]
		)
	})
}

const getImageSize = () => {
	let size = _.sum(_.map(DEFINITION.partitions, 'size'))
	size += DEFINITION.firstPartitionOffset
	if (DEFINITION.partitionTableType === 'dos') {
		// Each logical partition is preceded with 1 MiB free space
		size += (DEFINITION.partitions.length - 3) * MiB
	}
	return size
}

const prepareDevice = async (device) => {
	await createPartitionTable(device)
	await formatPartitions(device)
	await Promise.using(
		tmpMountDisposer(`${device}p${getPartition('resin-boot').position}`),
		tmpMountDisposer(`${device}p${getPartition('resin-rootA').position}`),
		tmpMountDisposer(`${device}p${getPartition('resin-rootB').position}`),
		async (bootMountpoint, rootAMountpoint, rootBMountpoint) => {
			await createDirectories(rootAMountpoint)
			await Promise.using(dockerdDisposer(DEFINITION.dockerStorageDriver, `${rootAMountpoint}/balena`), async (docker) => {
				const { volume, volumeId, containerId } = await dockerPull(
					docker,
					DEFINITION.dockerImage,
					bootMountpoint,
					rootAMountpoint,
					rootBMountpoint
				)
				await createLinks(rootAMountpoint, containerId, volumeId)
				console.log(
					'done pulling',
					volume,
					fs.readdirSync(volume),
					//fs.readdirSync(volume.slice(0, -6)),
					fs.readdirSync(`${rootAMountpoint}/balena`),
					//fs.readdirSync(`${rootAMountpoint}/balena/overlay2`),
					fs.readdirSync(`${rootAMountpoint}/balena/containers`),
					fs.readdirSync(`${rootAMountpoint}/balena/image`)
				)
			})
		}
	)
}

const toSectors = (bytes) => {
	return bytes / SECTOR_SIZE
}

const isBlockDevice = async (path) => {
	const stat = await fs.statAsync(path)
	return stat.isBlockDevice()
}

const main = async () => {
	try {
		console.log('trakaka0', process.argv)
		if ((process.argv.length === 3) && (await isBlockDevice(process.argv[2]))) {
			console.log('trakaka')
			await prepareDevice(process.argv[2])
		} else {
			const file = 'resin.img'
			await createZeroFilledFile(file, getImageSize())
			await Promise.using(losetupDisposer(file), async (device) => {
				await prepareDevice(device)
			})
		}
	} catch (err) {
		console.log('boom', err)
	}
}

main()


//# Load new hostapp
//if [ "$local_image" != "" ]; then
//	HOSTAPP_IMAGE=$(docker load --quiet -i "$local_image" | cut -d: -f1 --complement | tr -d ' ')
//elif [ "$remote_image" != "" ]; then
//	HOSTAPP_IMAGE="$remote_image"
//	docker pull "$HOSTAPP_IMAGE"
//fi
//CONTAINER_ID=$(docker create --runtime="bare" --volume=/boot "$HOSTAPP_IMAGE" /bin/sh)
//BOOTSTRAP=$(docker inspect -f "{{range .Mounts}}{{.Destination}} {{.Source}}{{end}}" "$CONTAINER_ID" | awk '$1 == "/boot" { print $2 }' | head -n1)

//# Create boot entry
//rm -rf "$SYSROOT/hostapps/.new"
//mkdir -p "$SYSROOT/hostapps/.new"
//ln -sr "$BOOTSTRAP" "$SYSROOT/hostapps/.new/boot"
//sync -f "$SYSROOT"
//mv -T "$SYSROOT/hostapps/.new" "$SYSROOT/hostapps/$CONTAINER_ID"
//sync -f "$SYSROOT"

//# Mark it as current hostapp
//ln -srf "$SYSROOT/hostapps/$CONTAINER_ID" "$SYSROOT/current.new"
//sync -f "$SYSROOT"
//mv -T "$SYSROOT/current.new" "$SYSROOT/current"
//sync -f "$SYSROOT"

//# Mark it as current partition
//cur_counter=0
//if [ -f "/mnt/sysroot/active/counter" ]; then
//	cur_counter=$(cat /mnt/sysroot/active/counter)
//fi
//echo $(($cur_counter + 1)) > "$SYSROOT/counter.new"
//sync -f "$SYSROOT"
//mv "$SYSROOT/counter.new" "$SYSROOT/counter"
//sync -f "$SYSROOT"

//# Run any defined hooks
//for hook in "/etc/hostapp-update-hooks.d/"*; do
//	[ -e "$hook" ] || break
//	"$hook" "$CONTAINER_ID"
//done
