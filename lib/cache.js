
const redis = require('redis').createClient({
  host: 'redis-14394.c16.us-east-1-3.ec2.cloud.redislabs.com',
  port: 14394,
  password: process.env.REDIS_PASS
})

redis.on('error', err => { console.error('Redis error', err) })

const mapToWs = {}

function toJson(str) {
	let resp
	try {
		resp = JSON.parse(str)
	} catch(e) {
		console.error('Redis parse error', e)
	}
	return resp
}

module.exports = {
	map: {
		get: (kitsuId, cb) => {
			if (!kitsuId) cb()
			else {
				if (mapToWs[kitsuId]) cb(mapToWs[kitsuId])
				else
					redis.get('kitsu-ws-' + kitsuId, (err, wsId) => {
						if (!err && wsId) cb(wsId)
						else cb()
					})
			}
		},
		set: (kitsuId, data) => {
			if (!mapToWs[kitsuId]) {
				mapToWs[kitsuId] = data
				redis.set('kitsu-ws-' + kitsuId, data)
			}
		}
	},
	catalog: {
		set: (key, data) => {
			if (!key) return
			redis.set('ws-catalog-' + key, JSON.stringify(data))
		},
		get: (key, cb) => {
			if (!key) {
				cb()
				return
			}
			redis.get('ws-catalog-' + key, (err, redisRes) => {

				if (!err && redisRes) {
					const redisCatalog = toJson(redisRes)
					if (redisCatalog) {
						cb(redisCatalog)
						return
					}
				}
				cb()
			})
		}
	}
}
