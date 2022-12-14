import log from './log.mjs'
import discord from 'discord.js'
import { config } from './config.mjs'
import { requestTag } from './verify.mjs'
import { cached, dataIsCached, cacheData, addGlobalRatelimit, cachedTag } from './cache.mjs'
import { verifyEndpoint } from './tags.mjs'
import { downloadImage } from './danbooru.mjs'

const webhookClient = new discord.WebhookClient({ url: process.env.WEBHOOK_URL })

/**
 * writes necessary image data
 * @param {import('express').Response} res
 * @param {import('./type.mjs').apiCombined} data
 * @param {Boolean} download - tell the browser to download the image
 */
async function writeImageData (res, data, download = false) {
  const tagEndpoint = data.endpoint ?? data.tag
  const headers = {
    'content-type': data.mime,
    'content-length': data.image.length,
    'mimi-image': data.url,
    'mimi-post': `https://danbooru.donmai.us/posts/${data.id}`,
    'mimi-tags': data.tags,
    'mimi-endpoint': tagEndpoint,
    'mimi-rating': data.rating
  }
  if (download === true) headers['content-disposition'] = `attachment; filename=${tagEndpoint}-${data.id}.${data.extension}`
  res.set(headers)
  res.write(data.image)
  log.log(`Served "${tagEndpoint}.${data.extension}": ${data.url} as https://danbooru.donmai.us/posts/${data.id}`)
  return true
}

/**
 * Check if we have cached data or not
 * @param {String} ip - ip address
 */
async function isCached (ip) {
  const requestCount = cached.ips[ip]?.requests
  const dataCached = await dataIsCached(ip)
  if (
    dataCached && ( // data cached
      requestCount >= config.requests.per || // too many requests for this ip
      cached.requests >= config.requests.max || // too many requests globally
      cached.ratelimit === true // ratelimited by danbooru
    )
  ) return { data: dataCached, cache: true }
  return { data: dataCached, cache: false }
}

/**
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('./type.mjs').rating} rating
 * @param {String} endpoint
 */
export async function get (req, res, rating = 'g', endpoint = 'fox', options = { image: true, forceCache: false, forceRaw: false, forceHD: false, forceDownload: false }) {
  const ip = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.ip
  const cachedData = await isCached(ip, req)
  if ((cachedData.cache || (cachedData.data && options.forceCache)) === true) {
    if (options.forceRaw === true) {
      await addGlobalRatelimit()
      const url = options.forceHD ? cachedData.data.urlhd : cachedData.data.url
      const downloadedImage = await downloadImage(url)
      if (downloadedImage !== false) {
        cachedData.data.image = downloadedImage.image
        cachedData.data.mime = downloadedImage.mime
        cachedData.data.extension = downloadedImage.extension
      }
    }
    return await sendData(req, res, cachedData.data, options.image, options.forceDownload)
  }
  await addGlobalRatelimit()
  let data
  if (options.forceRaw === false) data = await cachedTag(ip, endpoint, rating)
  else data = await requestTag(endpoint, rating, options.image, options.forceHD)
  if (data?.image == null && cachedData.cache) return await sendData(req, res, cachedData.data, options.image, options.forceDownload)
  else if (data?.image == null) return res.status(404).end()
  else {
    sendWebhook(data)
    return await sendData(req, res, data, options.image, options.forceDownload)
  }
}
/**
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('./type.mjs').apiCombined} data
 * @param {Boolean} image - whenever to serve an image or to redirect you
 * @param {Boolean} download - if serving the image, download the image?
 */
async function sendData (req, res, data, image = true, download = false) {
  await cacheData(req, data)
  if (image === false) return res.redirect(data.url)
  await writeImageData(res, data, download)
  return res.status(200).end()
}
/**
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function determineEndpoint (req, res, next) {
  const endpoint = req.params['0']
  const modifier = req.params['1']
  const modifer2 = req.params['2'] ?? req.params['1']
  const success = await serveEndpoint(req, res, endpoint, modifier, modifer2)
  if (!success) return next()
  return true
}

/**
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function determineModifier (req, res, next, endpoint = 'random') {
  const modifier = req.params['0']
  const modifer2 = req.params['1'] ?? req.params['0']
  const success = await serveEndpoint(req, res, endpoint, modifier, modifer2)
  if (!success) return next()
  return true
}

/**
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {String} endpoint - a valid endpoint in endpoints or "random"
 * @param {String} modifier - content rating modifier or image modifier
 * @param {String} modifier2 - image modifier
 */
export async function serveEndpoint (req, res, endpoint, modifier, modifier2) {
  endpoint = await verifyEndpoint(endpoint)
  if (endpoint === false) return false
  log.log(`Requesting: ${endpoint}:${modifier}`)
  const options = { image: true, forceCache: false, forceRaw: false, forceHD: false, forceDownload: false }
  let rating = 'g'
  switch (modifier) {
    case 'nsfw': {
      rating = 'q'
      break
    }
    case 'lewd': {
      rating = 's'
      break
    }
    case 'r': {
      options.image = false
      break
    }
    case 'c': {
      options.forceCache = true
      break
    }
    case 'd': {
      options.image = true
      options.forceDownload = true
      break
    }
    case 'w': {
      options.forceHD = true
      options.forceRaw = true
      break
    }
    default: {
      rating = 'g'
      break
    }
  }
  if (!modifier2) modifier2 = modifier
  switch (modifier2) {
    case 'r': {
      options.image = false
      break
    }
    case 'c': {
      options.forceCache = true
      break
    }
    case 'd': {
      options.image = true
      options.forceDownload = true
      break
    }
    case 'w': {
      options.forceHD = true
      options.forceRaw = true
      break
    }
    default: {
      break
    }
  }
  await get(req, res, rating, endpoint, options)
  return true
}

/**
 * send an image to a webhook
 * @param {import('./type.mjs').apiCombined} data
 */
async function sendWebhook (data) {
  if (data?.rating !== 'g' || !data?.image) return // horny no more!
  if (data?.image.length >= 8000000) {
    log.error(`Image size: ${data.image.length} is bigger than 8MB (8000000 bytes)`)
    return
  }
  const webhookContent = {
    username: 'mimi.usbwire.net',
    files: [data.image]
  }
  try {
    await webhookClient.send(webhookContent)
  } catch (e) {
    log.error(e)
  }
}
