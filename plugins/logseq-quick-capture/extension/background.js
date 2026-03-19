// background.js — service worker: retries queued notes + syncs bookmarks to Logseq

const RETRY_ALARM = 'qc-retry'
const RETRY_INTERVAL_MINUTES = 1

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_INTERVAL_MINUTES })

  // Context menu for right-click entertainment capture
  chrome.contextMenus.create({
    id: 'track-entertainment',
    title: '🎬 Track as Entertainment',
    contexts: ['selection', 'link', 'image', 'page'],
  })
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'track-entertainment') return
  const pending = {
    title:    info.selectionText || info.linkText || '',
    url:      info.linkUrl      || info.pageUrl  || '',
    imageUrl: info.srcUrl       || '',
  }
  chrome.storage.local.set({ qc_pending_ent: pending })
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RETRY_ALARM) {
    await tryFlushQueue()
  }
})

async function getSettings() {
  const { qc_settings = {} } = await chrome.storage.local.get('qc_settings')
  return {
    apiPort: qc_settings.apiPort || 12315,
    authToken: qc_settings.authToken || '',
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

  return response.json()
}

function extractBlockUuid(result) {
  if (!result) return null
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    for (const entry of result) {
      const nested = extractBlockUuid(entry)
      if (nested) return nested
    }
    return null
  }
  if (typeof result === 'object') {
    if (typeof result.uuid === 'string') return result.uuid
    if (result.block) return extractBlockUuid(result.block)
    if (result.data) return extractBlockUuid(result.data)
  }
  return null
}

function normalizeEntStatus(status) {
  return status === 'done' ? 'watched' : (status || 'watching')
}

function formatEntRootContent(item) {
  const posterCell = item.posterUrl
    ? `![${item.title}](${item.posterUrl}){:height 121, :width 107}`
    : `**${item.title}**`
  const typeCell = item.type === 'series' ? 'series' : 'movie'
  const yearCell = item.year || '----'
  return `||||\n|${posterCell}|${typeCell}|${yearCell}|[[GreenLight]]|`
}

function formatEntLogContent(item, action) {
  const titleStr = item.url ? `[${item.title}](${item.url})` : item.title
  if (action === 'add') {
    const normalized = normalizeEntStatus(item.status)
    const verb = normalized === 'plan'
      ? '📋 Plan to watch'
      : normalized === 'watched'
        ? '✅ Watched'
        : '▶️ Started watching'
    let content = `${verb}: **${titleStr}**`
    if (item.type === 'series') content += ` — S${item.season}E${item.episode}`
    return content
  }
  if (action === 'watched') {
    return `✅ Watched (${new Date().toLocaleDateString()}): **${titleStr}**`
  }
  if (action === 'progress') {
    return `📺 Progress: **${titleStr}** — S${item.season}E${item.episode}`
  }
  return null
}

async function persistEntRootBlockUuid(itemId, rootBlockUuid) {
  const { qc_entertainment = [] } = await chrome.storage.local.get('qc_entertainment')
  const idx = qc_entertainment.findIndex((entry) => entry.id === itemId)
  if (idx === -1) return
  qc_entertainment[idx] = {
    ...qc_entertainment[idx],
    rootBlockUuid,
    updatedAt: new Date().toISOString(),
  }
  await chrome.storage.local.set({ qc_entertainment })
}

async function ensureEntRootBlock(item, apiPort, authToken) {
  if (item.rootBlockUuid) return item.rootBlockUuid

  const created = await callLogseqApi(
    'logseq.Editor.appendBlockInPage',
    ['Entertainment', formatEntRootContent(item)],
    apiPort,
    authToken
  )
  const rootBlockUuid = extractBlockUuid(created)
  if (!rootBlockUuid) throw new Error('Could not create entertainment root block')

  item.rootBlockUuid = rootBlockUuid
  await persistEntRootBlockUuid(item.id, rootBlockUuid)
  return rootBlockUuid
}

async function processEntSyncQueueItem(queueItem, apiPort, authToken) {
  const item = { ...queueItem.entItem }
  if (queueItem.action === 'add' || queueItem.action === 'root-update') {
    const content = formatEntRootContent(item)
    if (item.rootBlockUuid) {
      await callLogseqApi('logseq.Editor.updateBlock', [item.rootBlockUuid, content], apiPort, authToken)
    } else {
      await ensureEntRootBlock(item, apiPort, authToken)
    }
  } else {
    await ensureEntRootBlock(item, apiPort, authToken)
  }

  const logContent = formatEntLogContent(item, queueItem.action)
  if (logContent) {
    await callLogseqApi('logseq.Editor.appendBlock', [item.rootBlockUuid, logContent, false], apiPort, authToken)
  }
}

async function tryFlushQueue() {
  const { qc_queue = [] } = await chrome.storage.local.get('qc_queue')
  if (qc_queue.length === 0) return

  const { apiPort, authToken } = await getSettings()
  const failed = []

  for (const item of qc_queue) {
    try {
      if (item.kind === 'ent-sync') {
        await processEntSyncQueueItem(item, apiPort, authToken)
      } else {
        const blocks = Array.isArray(item.blocks) && item.blocks.length ? item.blocks : [item.content]
        for (const block of blocks) {
          await callLogseqApi('logseq.Editor.appendBlockInPage', [item.targetPage, block], apiPort, authToken)
        }
      }
    } catch {
      // Logseq is still offline — stop and keep all remaining in queue
      failed.push(item)
      break
    }
  }

  await chrome.storage.local.set({ qc_queue: failed })
}

// ── Bookmark sync ─────────────────────────────────────────────────────────────

async function getWatchedFolders() {
  const { qc_bookmark_folders = [] } = await chrome.storage.local.get('qc_bookmark_folders')
  return qc_bookmark_folders // [{id, name}]
}

async function sendBlock(content, targetPage, port, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const response = await fetch(`http://localhost:${port}/api`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'logseq.Editor.appendBlockInPage',
      args: [targetPage, content],
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

async function queueNote(content, targetPage) {
  const { qc_queue = [] } = await chrome.storage.local.get('qc_queue')
  qc_queue.push({ content, targetPage, timestamp: new Date().toISOString() })
  await chrome.storage.local.set({ qc_queue })
}

chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  // bookmark.url is undefined for folders — skip those
  if (!bookmark.url) return

  const watchedFolders = await getWatchedFolders()
  const watched = watchedFolders.find(f => f.id === bookmark.parentId)
  if (!watched) return

  const { apiPort, authToken } = await getSettings()
  const targetPage = watched.name
  const title = bookmark.title || bookmark.url
  // Block format: [Title](URL) #bookmark  – also tag with #FolderName
  const folderTag = watched.name.replace(/\s+/g, '-')
  const blockContent = `[${title}](${bookmark.url}) #bookmark #${folderTag}`

  try {
    await sendBlock(blockContent, targetPage, apiPort, authToken)
  } catch {
    await queueNote(blockContent, targetPage)
  }
})
