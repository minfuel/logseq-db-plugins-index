// background.js — service worker: periodic project data refresh + badge updates

const REFRESH_ALARM = 'pt-refresh'
const REFRESH_INTERVAL_MINUTES = 2

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_INTERVAL_MINUTES })
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    await refreshData()
  }
})

// Message handler so popup can request an immediate refresh
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh') {
    refreshData()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true // keep channel open for async response
  }
})

async function getSettings() {
  const { pt_settings = {} } = await chrome.storage.local.get('pt_settings')
  return {
    apiPort: pt_settings.apiPort || 12315,
    authToken: pt_settings.authToken || '',
  }
}

async function callLogseqApi(method, args, apiPort, authToken) {
  const headers = { 'Content-Type': 'application/json' }
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  const response = await fetch(`http://localhost:${apiPort}/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, args }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}`)
  }

  const payload = await response.json()
  return unwrapLogseqResponse(payload)
}

function unwrapLogseqResponse(payload) {
  if (!payload || typeof payload !== 'object') return payload

  if (payload.error) {
    if (typeof payload.error === 'string') throw new Error(payload.error)
    throw new Error(payload.error.message || 'Logseq API error')
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'result')) return payload.result
  if (Object.prototype.hasOwnProperty.call(payload, 'data')) return payload.data
  return payload
}

async function refreshData() {
  const { apiPort, authToken } = await getSettings()

  try {
    // ── Fetch projects from both page titles and tagged block content ──────
    const [allPagesRaw, projectBlocks] = await Promise.all([
      callLogseqApi('logseq.Editor.getAllPages', [], apiPort, authToken),
      fetchBlocksByHashtag('project', apiPort, authToken),
    ])

    const allPages = normalizePagesFromGetAll(allPagesRaw)
    const projectFromPageTitle = allPages.filter((p) => pageTitleHasTag(p, 'project'))
    const projectFromBlocks = projectBlocks
      .map(tupleToPageEntity)
      .filter(Boolean)

    const mergedProjects = dedupePages([...projectFromPageTitle, ...projectFromBlocks])

    const projects = mergedProjects

    // ── Fetch feed items: news, events, requests ────────────────────────────
    const feedTypes = ['news', 'event', 'request']
    let feedItems = []

    for (const type of feedTypes) {
      const feedQuery = `[:find (pull ?b [:block/content :block/uuid :block/updated-at {:block/page [:block/original-name]}])
        :where
        [?b :block/tags ?t]
        [?t :block/title "${type}"]]`

      try {
        const feedResult = await callLogseqApi(
          'logseq.DB.datascriptQuery', [feedQuery], apiPort, authToken
        )
        const items = (feedResult || [])
          .map(r => ({ ...r[0], _type: type }))
          .filter(Boolean)
        feedItems = feedItems.concat(items)
      } catch {
        // skip failed type silently
      }
    }

    feedItems.sort((a, b) => (b['block/updated-at'] || 0) - (a['block/updated-at'] || 0))

    // ── Badge: count new feed items since last refresh ─────────────────────
    const { pt_feed_cache = [] } = await chrome.storage.local.get('pt_feed_cache')
    const knownUuids = new Set(pt_feed_cache.map(f => f['block/uuid']))
    const newCount = feedItems.filter(f => !knownUuids.has(f['block/uuid'])).length

    if (newCount > 0) {
      chrome.action.setBadgeText({ text: String(newCount) })
      chrome.action.setBadgeBackgroundColor({ color: '#f38ba8' })
    } else {
      chrome.action.setBadgeText({ text: '' })
    }

    // ── Store in cache ─────────────────────────────────────────────────────
    await chrome.storage.local.set({
      pt_projects_cache: projects,
      pt_feed_cache: feedItems.slice(0, 60),
      pt_last_refresh: Date.now(),
    })
  } catch {
    // Logseq offline or unreachable — silently skip
  }
}

async function fetchBlocksByHashtag(tagName, apiPort, authToken) {
  const query = `[:find (pull ?b [:block/uuid :block/content :block/updated-at {:block/page [:block/original-name :block/name :block/uuid :block/properties :block/updated-at]}])
    :where
    [?b :block/content ?c]
    [(re-find #"(?i)(^|\\s)#${tagName}\\b" ?c)]]`

  const result = await callLogseqApi('logseq.DB.datascriptQuery', [query], apiPort, authToken)
  return Array.isArray(result) ? result : []
}

function normalizePagesFromGetAll(pages) {
  if (!Array.isArray(pages)) return []

  return pages.map((p) => ({
    'block/original-name': p['block/original-name'] || p.originalName || p.name || '',
    'block/name': p['block/name'] || p.name || '',
    'block/uuid': p['block/uuid'] || p.uuid || '',
    'block/updated-at': p['block/updated-at'] || p.updatedAt || Date.now(),
    'block/properties': p['block/properties'] || p.properties || {},
  }))
}

function pageTitleHasTag(page, tagName) {
  const title = String(page['block/original-name'] || page['block/name'] || '')
  const rx = new RegExp(`(^|\\s)#${tagName}\\b`, 'i')
  return rx.test(title)
}

function dedupePages(items) {
  const byUuid = new Map()
  for (const item of items) {
    const key = item['block/uuid'] || item['block/name']
    if (!key) continue
    const prev = byUuid.get(key)
    if (!prev || (item['block/updated-at'] || 0) > (prev['block/updated-at'] || 0)) {
      byUuid.set(key, item)
    }
  }
  return [...byUuid.values()]
}

function tupleToPageEntity(tuple) {
  const block = Array.isArray(tuple) ? tuple[0] : tuple
  const page = block?.['block/page']
  if (!page) return null

  return {
    'block/original-name': page['block/original-name'] || page['block/name'] || '',
    'block/name': page['block/name'] || page['block/original-name'] || '',
    'block/uuid': page['block/uuid'] || '',
    'block/updated-at': block['block/updated-at'] || page['block/updated-at'] || Date.now(),
    'block/properties': page['block/properties'] || {},
  }
}
