const needle = require('needle')
const async = require('async')
const pUrl = require('url').parse
const db = require('./lib/cache')

const package = require('./package')

const manifest = {
    id: 'org.wonderfulsubs.anime',
    version: package.version,
    logo: 'https://pbs.twimg.com/profile_images/1042973894347350016/SZDq-peE_200x200.jpg',
    name: 'WonderfulSubs Anime',
    description: 'Anime from WonderfulSubs',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['kitsu:'],
    catalogs: [
      {
        type: 'series',
        id: 'wonderfulsubs-search',
        name: 'WonderfulSubs',
        extra: [
          {
            name: 'search',
            isRequired: true
          }
        ]
      }, {
        type: 'series',
        id: 'wonderfulsubs-popular',
        name: 'WonderfulSubs Popular'
      }, {
        type: 'series',
        id: 'wonderfulsubs-latest',
        name: 'WonderfulSubs Latest'
      }
    ]
}

const { addonBuilder }  = require('stremio-addon-sdk')

const addon = new addonBuilder(manifest)

const endpoint = 'https://www.wonderfulsubs.com/api/media/'

const headers = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.121 Safari/537.36',
  'Referer': 'https://www.wonderfulsubs.com/',
}

const cache = {
  streams: {},
  catalog: {}
}

function toMeta(obj) {
  if (obj.url)
    db.map.set(obj.kitsu_id, obj.url.replace('/watch/', ''))
  return {
    id: 'kitsu:' + obj.kitsu_id,
    name: obj.title,
    description: obj.description,
    poster: ((obj.poster_tall || {})[2] || {}).source,
    type: 'series'
  }
}

addon.defineCatalogHandler(args => {
  return new Promise((resolve, reject) => {

    let url = endpoint

    if (args.id == 'wonderfulsubs-popular')
      url += 'popular?count=25'
    else if (args.id == 'wonderfulsubs-latest')
      url += 'latest?count=25'
    else
      url += 'search?q=' + encodeURIComponent(args.extra.search)

    if (cache.catalog[url]) {
      resolve({ metas: cache.catalog[url], cacheMaxAge: 259200 })
      return
    }

    const redisKey = args.extra.search ? null : args.id

    db.catalog.get(redisKey, redisMetas => {

      if (redisMetas)
        resolve({ metas: redisMetas, cacheMaxAge: 86400 })

      needle.get(url, { headers }, (err, resp, body) => {
        const series = ((body || {}).json || {}).series || []
        const metas = series.map(toMeta)
        if (metas.length) {
          cache.catalog[url] = metas
          // cache for 3 days
          setTimeout(() => {
            delete cache.catalog[url]
          }, 259200000)
          if (redisKey)
            db.catalog.set(redisKey, metas)
          if (!redisMetas)
            resolve({ metas, cacheMaxAge: 259200 })
        } else if (!redisMetas)
          reject(new Error('Catalog error: '+JSON.stringify(args)))
      })

    })

  })
})

const kitsuEndpoint = 'https://addon.stremio-kitsu.cf'

addon.defineMetaHandler(args => {
  return new Promise((resolve, reject) => {
    needle.get(kitsuEndpoint + '/meta/' + args.type + '/' + args.id + '.json', (err, resp, body) => {
      if (body && body.meta)
        resolve(body)
      else
        reject(new Error('Could not get meta from kitsu api for: '+args.id))
    })
  })
})

function getHost(str) {
  let host = pUrl(str).hostname
  const hostParts = host.split('.')
  if (hostParts.length > 2) {
    hostParts.shift()
    host = hostParts.join('.')
  }
  return host
}

addon.defineStreamHandler(args => {
  return new Promise((resolve, reject) => {
    if (cache.streams[args.id]) {
      resolve({ streams: cache.streams[args.id], cacheMaxAge: 300 })
      return
    }
    const id = args.id
    const idParts = id.split(':')
    const kitsuId = idParts[1]
    const episode = idParts.length > 2 ? idParts[idParts.length -1] : 1
    db.map.get(kitsuId, wsId => {
      if (wsId) {
        needle.get('http://goxcors.appspot.com/cors?method=GET&url=' + encodeURIComponent(endpoint + 'series?series=' + wsId), { headers }, (err, resp, body) => {
          if (body && typeof body == 'string')
            try {
              body = JSON.parse(body)
            } catch(e) {}
          const episodes = ((((((body || {}).json || {}).seasons || {}).ws || {}).media || [])[0] || {}).episodes || []
          let sources = []
          function addEpisode(ep) {
            ((ep || {}).sources || []).forEach(source => {
              if (Array.isArray(source.retrieve_url))
                sources = sources.concat(source.retrieve_url.map(el => { return { language: source.language, retrieve_url: el, source: source.source } }))
              else if (source.retrieve_url)
                sources.push(source)
            })
          }
          episodes.forEach(ep => {
            if (ep.episode_number == episode || (!ep.episode_number && !episode))
              addEpisode(ep)
          })

          if (!sources.length)
            addEpisode(episodes[0])

          if (sources.length) {
            let streams = []
            const queue = async.queue((task, cb) => {
              needle.get('http://goxcors.appspot.com/cors?method=GET&url=' + encodeURIComponent(endpoint + 'stream?code=' + encodeURIComponent(task.retrieve_url)), { headers }, (err, resp, body) => {
                if (body && typeof body == 'string')
                  try {
                    body = JSON.parse(body)
                  } catch(e) {}
                const urls = (body || {}).urls || []
                if (Array.isArray(urls))
                  streams = streams.concat(urls.map(el => { return { title: task.language.toUpperCase() + ' - ' + el.label + '\n' + getHost(el.src), url: el.src } }))
                else if (urls == (body || {}).embed)
                  streams.push({ title: task.language.toUpperCase() + ' - External\n' + getHost(urls), externalUrl: urls })
                cb()
              })
            }, 1)
            queue.drain = () => {
              cache.streams[args.id] = streams
              setTimeout(() => {
                delete cache.streams[args.id]
              }, 300000) // cache 5 mins
              resolve({ streams, cacheMaxAge: 300 }) // cache 5 min
            }
            sources.forEach(el => { queue.push(el) })
          } else
            reject('Could not get stream sources for: ' + args.id)
        })
      } else
        reject('Could not get streams for: ' + args.id)
    })
  })
})

module.exports = addon.getInterface()
