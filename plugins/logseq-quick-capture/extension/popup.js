// popup.js — handles the Quick Capture popup UI

// ── Image state ───────────────────────────────────────────────────────────────
// Each entry: { dataUrl: 'data:image/jpeg;base64,...', name: 'photo.jpg' }
let attachedImages = []

/** Compress an image data-URL to JPEG, max 1024px on the longest side. */
function compressImage(dataUrl, maxDim = 1024, quality = 0.75) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim }
        else                 { width  = Math.round(width  * maxDim / height); height = maxDim }
      }
      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.src = dataUrl
  })
}

/** Read a File object as a compressed data-URL. */
async function fileToCompressedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = async (e) => resolve(await compressImage(e.target.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Add one image to attachedImages and re-render the preview strip. */
async function addImage(dataUrl, name = 'image.jpg') {
  const compressed = await compressImage(dataUrl)
  attachedImages.push({ dataUrl: compressed, name })
  renderImagePreviews()
}

function renderImagePreviews() {
  const strip = document.getElementById('imgPreviewStrip')
  if (attachedImages.length === 0) { strip.classList.add('hidden'); return }
  strip.classList.remove('hidden')
  strip.innerHTML = attachedImages
    .map((img, i) => `
      <div class="img-thumb-wrap">
        <img src="${img.dataUrl}" alt="attached image ${i + 1}" />
        <button class="img-thumb-remove" data-idx="${i}" title="Remove">✕</button>
      </div>`)
    .join('')
  strip.querySelectorAll('.img-thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      attachedImages.splice(parseInt(btn.dataset.idx, 10), 1)
      renderImagePreviews()
    })
  })
}

const DEFAULTS = {
  apiPort: 12315,
  authToken: '',
  targetPage: 'Inbox',
  defaultTags: 'QuickCapture',
  ytApiKey: '',
  openAiKey: '',
  tmdbApiKey: '',
}

let settings = { ...DEFAULTS }

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTodayJournalName() {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildBlockContent(content, isTodo, rawTags) {
  let block = content.trim()
  if (!block) return null

  if (isTodo) block = `TODO ${block}`

  const tagList = rawTags
    .split(',')
    .map(t => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .map(t => `#${t}`)
    .join(' ')

  return tagList ? `${block} ${tagList}` : block
}

// Convert plain URLs to markdown links so Logseq keeps them as rich clickable text.
function linkifyUrls(text) {
  return text.replace(/https?:\/\/[^\s<>()]+/g, (rawUrl, offset, fullText) => {
    const prevTwo = fullText.slice(Math.max(0, offset - 2), offset)
    if (prevTwo === '](') return rawUrl // already inside markdown link

    let url = rawUrl
    let trailing = ''
    while (/[),.!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing
      url = url.slice(0, -1)
    }

    return `[${url}](${url})${trailing}`
  })
}

function extractUrls(text) {
  const found = text.match(/https?:\/\/[^\s<>()]+/g) || []
  return found.map((u) => u.replace(/[),.!?]+$/, ''))
}

function getYouTubeVideoId(urlString) {
  try {
    const url = new URL(urlString)
    const host = url.hostname.replace(/^www\./, '')

    if (host === 'youtu.be') return url.pathname.slice(1) || null
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.searchParams.get('v')) return url.searchParams.get('v')
      const parts = url.pathname.split('/').filter(Boolean)
      if ((parts[0] === 'shorts' || parts[0] === 'embed') && parts[1]) return parts[1]
    }
  } catch {
    return null
  }
  return null
}

function buildYouTubePreviewBlocks(text) {
  const urls = extractUrls(text)
  const ids = [...new Set(urls.map(getYouTubeVideoId).filter(Boolean))]

  return ids.map((id) => {
    const watchUrl = `https://www.youtube.com/watch?v=${id}`
    const thumbUrl = `https://img.youtube.com/vi/${id}/hqdefault.jpg`
    return `![YouTube preview](${thumbUrl})\n[▶ Watch on YouTube](${watchUrl}) #youtube`
  })
}

function buildNoteBlocks(content, isTodo, rawTags, images) {
  const linkedContent = linkifyUrls(content)
  const mainBlock = buildBlockContent(linkedContent, isTodo, rawTags)
  const imageBlocks = images.map((img, i) => `![image ${i + 1}](${img.dataUrl})`)
  const ytPreviewBlocks = buildYouTubePreviewBlocks(content)
  return [mainBlock, ...imageBlocks, ...ytPreviewBlocks].filter(Boolean)
}

function normalizeEntStatus(status) {
  return status === 'done' ? 'watched' : (status || 'watching')
}

function getEntStatusLabel(status) {
  const normalized = normalizeEntStatus(status)
  return {
    watching: '▶️ Watching',
    plan: '📋 Plan',
    watched: '✅ Watched',
  }[normalized] || '▶️ Watching'
}

// ── URL path helper ───────────────────────────────────────────────────────────

function extractUrlPath(rawUrl) {
  if (!rawUrl) return ''
  try {
    const parsed = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`)
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return rawUrl.startsWith('/') ? rawUrl : rawUrl
  }
}

function inferEntTypeFromCategory(category) {
  const normalized = String(category || '').toLowerCase()
  return new Set(['tv', 'tv_show', 'show', 'series']).has(normalized) ? 'series' : 'movie'
}

// ── Poster search (TMDB + NeoDB fallback) ─────────────────────────────────────

async function fetchTmdbResults(title, type, apiKey) {
  if (!apiKey || !title) return []
  const endpoint = type === 'series' ? 'tv' : 'movie'
  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
    include_adult: 'false',
    language: 'en-US',
    page: '1',
  })
  const response = await fetch(`https://api.themoviedb.org/3/search/${endpoint}?${params}`)
  if (!response.ok) return []
  const data = await response.json()
  return (data.results || [])
    .filter(r => r.poster_path)
    .slice(0, 8)
    .map(r => {
      const yearSource = type === 'series' ? r.first_air_date : r.release_date
      return {
        posterUrl: `https://image.tmdb.org/t/p/w185${r.poster_path}`,
        title: r.title || r.name || title,
        year: yearSource ? String(yearSource).slice(0, 4) : null,
      }
    })
}

async function fetchNeodbPosterOptions(title, type) {
  const params = new URLSearchParams({ query: title, page: '1' })
  const response = await fetch(`https://neodb.social/api/catalog/search?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return []
  const data = await response.json()
  const items = data.data || data.results || []
  const typeCategories = type === 'series'
    ? new Set(['tv', 'tv_show', 'show', 'series'])
    : new Set(['movie', 'film'])
  const withPoster = items.filter(r => r.cover_image_url)
  const categoryMatched = withPoster.filter((r) => {
    const category = String(r.category || '').toLowerCase()
    return typeCategories.has(category)
  })
  const source = categoryMatched.length ? categoryMatched : withPoster
  return source
    .slice(0, 8)
    .map(r => ({
      posterUrl: r.cover_image_url,
      title: r.display_title || r.title || title,
      year: r.year
        ? String(r.year)
        : (r.release_date ? String(r.release_date).slice(0, 4) : null),
    }))
}

async function fetchNeodbSuggestions(query) {
  if (!query.trim()) return []
  const params = new URLSearchParams({ query, page: '1' })
  const response = await fetch(`https://neodb.social/api/catalog/search?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return []
  const data = await response.json()
  const items = data.data || data.results || []
  return items
    .slice(0, 8)
    .map((r) => ({
      title: r.display_title || r.title || query,
      posterUrl: r.cover_image_url || null,
      year: r.year
        ? String(r.year)
        : (r.release_date ? String(r.release_date).slice(0, 4) : null),
      type: inferEntTypeFromCategory(r.category),
    }))
}

// ── Poster picker state ───────────────────────────────────────────────────────

let selectedPosterUrl = null
let selectedYear = null
let posterSearchTimer = null

async function triggerPosterSearch(title, type) {
  clearTimeout(posterSearchTimer)
  if (!title.trim()) { renderPosterPicker([], false); return }
  renderPosterPicker([], true)
  posterSearchTimer = setTimeout(async () => {
    let options = []
    try {
      if (settings.tmdbApiKey) {
        options = await fetchTmdbResults(title, type, settings.tmdbApiKey)
      } else {
        options = await fetchNeodbPosterOptions(title, type)
      }
    } catch { /* poster search is optional */ }
    renderPosterPicker(options, false)
  }, 600)
}

function renderPosterPicker(options, loading) {
  const picker = document.getElementById('entPosterPicker')
  if (!picker) return
  if (loading) {
    picker.innerHTML = '<div class="ent-poster-picker-hint">Searching posters…</div>'
    picker.classList.remove('hidden')
    return
  }
  if (options.length === 0) {
    picker.classList.add('hidden')
    picker.innerHTML = ''
    return
  }
  picker.classList.remove('hidden')
  picker.innerHTML = `
    <div class="ent-poster-picker-hint">Click a poster to select it</div>
    <div class="ent-poster-grid">
      ${options.map(opt => `
        <div class="ent-poster-option${selectedPosterUrl === opt.posterUrl ? ' selected' : ''}"
             data-poster="${opt.posterUrl}"
             data-year="${opt.year || ''}"
             title="${opt.title}${opt.year ? ' (' + opt.year + ')' : ''}">
          <img src="${opt.posterUrl}" alt="${opt.title}" loading="lazy" />
        </div>`).join('')}
    </div>`
  picker.querySelectorAll('.ent-poster-option').forEach(el => {
    el.addEventListener('click', () => {
      selectedPosterUrl = el.dataset.poster
      selectedYear = el.dataset.year || null
      picker.querySelectorAll('.ent-poster-option').forEach(e => e.classList.remove('selected'))
      el.classList.add('selected')
    })
  })
}

async function callLogseqApi(method, args, port, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const response = await fetch(`http://localhost:${port}/api`, {
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

function formatEntRootContent(item) {
  const posterCell = item.posterUrl
    ? `![${item.title}](${item.posterUrl}){:height 121, :width 107}`
    : `**${item.title}**`
  const typeCell = item.type === 'series' ? 'series' : 'movie'
  const yearCell = item.year || '----'
  const typeTags = item.type === 'series' ? '#entertainment #series' : '#entertainment #movies'
  return `${typeTags}\n||||\n|${posterCell}|${typeCell}|${yearCell}|[[GreenLight]]|`
}

function formatEntLogContent(item, action) {
  const titleStr = item.title
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
  const items = await getEntItems()
  const idx = items.findIndex((entry) => entry.id === itemId)
  if (idx === -1) return
  items[idx] = { ...items[idx], rootBlockUuid, updatedAt: new Date().toISOString() }
  await saveEntItems(items)
}

async function ensureEntRootBlock(item) {
  if (item.rootBlockUuid) return item.rootBlockUuid

  const created = await callLogseqApi(
    'logseq.Editor.appendBlockInPage',
    ['Entertainment', formatEntRootContent(item)],
    settings.apiPort,
    settings.authToken
  )

  const rootBlockUuid = extractBlockUuid(created)
  if (!rootBlockUuid) throw new Error('Could not create entertainment root block')

  item.rootBlockUuid = rootBlockUuid
  await persistEntRootBlockUuid(item.id, rootBlockUuid)
  return rootBlockUuid
}

async function upsertEntRootBlock(item) {
  const content = formatEntRootContent(item)
  if (item.rootBlockUuid) {
    await callLogseqApi(
      'logseq.Editor.updateBlock',
      [item.rootBlockUuid, content],
      settings.apiPort,
      settings.authToken
    )
    return item.rootBlockUuid
  }

  return ensureEntRootBlock(item)
}

async function sendToLogseq(blockContent, targetPage, port, token) {
  const resolvedPage =
    targetPage.toLowerCase() === 'journal' ? getTodayJournalName() : targetPage
  return callLogseqApi('logseq.Editor.appendBlockInPage', [resolvedPage, blockContent], port, token)
}

function showStatus(el, message, type) {
  el.textContent = message
  el.className = `status ${type}`
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('qc_settings')
  if (stored.qc_settings) {
    settings = { ...DEFAULTS, ...stored.qc_settings }
  }
}

async function saveSettings(newSettings) {
  await chrome.storage.local.set({ qc_settings: newSettings })
  settings = { ...DEFAULTS, ...newSettings }
}

async function getQueue() {
  const { qc_queue = [] } = await chrome.storage.local.get('qc_queue')
  return qc_queue
}

async function pushToQueue(item) {
  const queue = await getQueue()
  queue.push(item)
  await chrome.storage.local.set({ qc_queue: queue })
}

async function flushQueue() {
  const queue = await getQueue()
  if (queue.length === 0) return 0

  const failed = []
  for (const item of queue) {
    try {
      const blocks = Array.isArray(item.blocks) && item.blocks.length ? item.blocks : [item.content]
      for (const block of blocks) {
        await sendToLogseq(block, item.targetPage, settings.apiPort, settings.authToken)
      }
    } catch {
      failed.push(item)
    }
  }
  await chrome.storage.local.set({ qc_queue: failed })
  return queue.length - failed.length
}

async function updatePendingBanner() {
  const queue = await getQueue()
  const banner = document.getElementById('pendingBanner')
  if (queue.length > 0) {
    document.getElementById('pendingCount').textContent = queue.length
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }
}

// ── Bookmark folder management ────────────────────────────────────────────────

async function getWatchedFolders() {
  const { qc_bookmark_folders = [] } = await chrome.storage.local.get('qc_bookmark_folders')
  return qc_bookmark_folders // [{id, name}]
}

async function saveWatchedFolders(folders) {
  await chrome.storage.local.set({ qc_bookmark_folders: folders })
}

/** Recursively collects all bookmark folders from the Chrome tree. */
function collectFolders(nodes, acc = []) {
  for (const node of nodes) {
    if (!node.url) {
      // It's a folder — skip the synthetic root node (id "0")
      if (node.id !== '0') acc.push({ id: node.id, name: node.title || '(unnamed)' })
      if (node.children) collectFolders(node.children, acc)
    }
  }
  return acc
}

async function populateFolderSelect(selectEl) {
  try {
    const tree = await chrome.bookmarks.getTree()
    const folders = collectFolders(tree)
    selectEl.innerHTML = folders.length
      ? folders.map(f => `<option value="${f.id}" data-name="${f.name}">${f.name}</option>`).join('')
      : '<option value="">No folders found</option>'
  } catch {
    selectEl.innerHTML = '<option value="">Error loading folders</option>'
  }
}

function renderWatchedFolders(folders, listEl, onRemove) {
  if (folders.length === 0) {
    listEl.innerHTML = '<div class="empty-hint">No folders watched yet.</div>'
    return
  }
  listEl.innerHTML = folders
    .map(
      f => `
      <div class="folder-item" data-id="${f.id}">
        <div class="folder-meta">
          <span class="folder-name">📁 ${f.name}</span>
          <span class="folder-page">→ Logseq page: <em>${f.name}</em> + #bookmark</span>
        </div>
        <button class="folder-remove" data-id="${f.id}" title="Stop watching">✕</button>
      </div>`
    )
    .join('')

  listEl.querySelectorAll('.folder-remove').forEach(btn => {
    btn.addEventListener('click', () => onRemove(btn.dataset.id))
  })
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings()
  await updatePendingBanner()

  // Populate settings form
  document.getElementById('apiPort').value = settings.apiPort
  document.getElementById('authToken').value = settings.authToken
  document.getElementById('targetPage').value = settings.targetPage
  document.getElementById('defaultTags').value = settings.defaultTags

  // Populate tag field with defaults
  document.getElementById('noteTags').value  = settings.defaultTags
  document.getElementById('ytApiKey').value  = settings.ytApiKey  || ''
  document.getElementById('openAiKey').value = settings.openAiKey || ''
  document.getElementById('tmdbApiKey').value = settings.tmdbApiKey || ''

  const noteContent  = document.getElementById('noteContent')
  const isTodo       = document.getElementById('isTodo')
  const noteTags     = document.getElementById('noteTags')
  const sendBtn      = document.getElementById('sendBtn')
  const sendBtnText  = document.getElementById('sendBtnText')
  const statusMsg    = document.getElementById('statusMsg')
  const settingsStatus = document.getElementById('settingsStatus')

  // Settings toggle
  document.getElementById('settingsToggle').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.toggle('hidden')
    document.getElementById('bookmarksPanel').classList.add('hidden')
  })

  // Bookmarks panel toggle
  const bookmarksPanel = document.getElementById('bookmarksPanel')
  const folderSelect   = document.getElementById('folderSelect')
  const watchedList    = document.getElementById('watchedFoldersList')
  const bookmarksStatus = document.getElementById('bookmarksStatus')

  document.getElementById('bookmarksToggle').addEventListener('click', async () => {
    bookmarksPanel.classList.toggle('hidden')
    document.getElementById('settingsPanel').classList.add('hidden')
    if (!bookmarksPanel.classList.contains('hidden')) {
      await populateFolderSelect(folderSelect)
      const watched = await getWatchedFolders()
      renderWatchedFolders(watched, watchedList, handleRemoveFolder)
    }
  })

  async function handleRemoveFolder(folderId) {
    const watched = await getWatchedFolders()
    const updated = watched.filter(f => f.id !== folderId)
    await saveWatchedFolders(updated)
    renderWatchedFolders(updated, watchedList, handleRemoveFolder)
    showStatus(bookmarksStatus, 'Folder removed', 'info')
    setTimeout(() => { bookmarksStatus.textContent = '' }, 2000)
  }

  document.getElementById('addFolderBtn').addEventListener('click', async () => {
    const opt = folderSelect.selectedOptions[0]
    if (!opt || !opt.value) return
    const watched = await getWatchedFolders()
    if (watched.find(f => f.id === opt.value)) {
      showStatus(bookmarksStatus, 'Already watching that folder', 'info')
      return
    }
    watched.push({ id: opt.value, name: opt.dataset.name || opt.text })
    await saveWatchedFolders(watched)
    renderWatchedFolders(watched, watchedList, handleRemoveFolder)
    showStatus(bookmarksStatus, `✓ Now watching "${opt.dataset.name || opt.text}"`, 'success')
    setTimeout(() => { bookmarksStatus.textContent = '' }, 2500)
  })

  // Save settings
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const newSettings = {
      apiPort:   parseInt(document.getElementById('apiPort').value, 10) || 12315,
      authToken: document.getElementById('authToken').value.trim(),
      targetPage: document.getElementById('targetPage').value.trim() || 'Inbox',
      defaultTags: document.getElementById('defaultTags').value.trim(),
      ytApiKey:  document.getElementById('ytApiKey').value.trim(),
      openAiKey: document.getElementById('openAiKey').value.trim(),
      tmdbApiKey: document.getElementById('tmdbApiKey').value.trim(),
    }
    await saveSettings(newSettings)
    showStatus(settingsStatus, '✓ Settings saved', 'success')
    setTimeout(() => { settingsStatus.textContent = '' }, 2000)
  })

  // Sync queued notes
  document.getElementById('syncNow').addEventListener('click', async () => {
    const synced = await flushQueue()
    showStatus(statusMsg, `Synced ${synced} note(s) to Logseq`, 'success')
    await updatePendingBanner()
  })

  // Send note
  sendBtn.addEventListener('click', async () => {
    const content = noteContent.value.trim()
    if (!content) {
      showStatus(statusMsg, 'Please enter a note', 'error')
      return
    }

    // Snapshot current images so reset doesn't clear them mid-send
    const images = attachedImages.slice()
    const blocks = buildNoteBlocks(content, isTodo.checked, noteTags.value, images)

    sendBtn.disabled = true
    sendBtnText.textContent = 'Sending…'

    try {
      for (const block of blocks) {
        await sendToLogseq(block, settings.targetPage, settings.apiPort, settings.authToken)
      }
      const imgNote = images.length ? ` + ${images.length} image(s)` : ''
      const ytNote = blocks.filter((b) => b.includes('YouTube preview')).length
      const ytSuffix = ytNote ? ` + ${ytNote} YouTube preview(s)` : ''
      showStatus(statusMsg, `✓ Sent to Logseq${imgNote}${ytSuffix}!`, 'success')
      resetForm(noteContent, isTodo, noteTags)
    } catch (_err) {
      // Logseq not running — queue all blocks for retry
      await pushToQueue({
        content: blocks[0] || content,
        blocks,
        targetPage: settings.targetPage,
        timestamp: new Date().toISOString(),
      })
      showStatus(statusMsg, '📋 Queued — will sync when Logseq is open', 'queued')
      resetForm(noteContent, isTodo, noteTags)
      await updatePendingBanner()
    } finally {
      sendBtn.disabled = false
      sendBtnText.textContent = 'Send to Logseq'
    }
  })

  // ── Image attachment ────────────────────────────────────────────────────

  // File picker
  const fileInput = document.getElementById('fileInput')
  document.getElementById('attachFileBtn').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      await addImage(await fileToCompressedDataUrl(file), file.name)
    }
    fileInput.value = ''
  })

  // Screenshot of active tab
  document.getElementById('screenshotBtn').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab) { showStatus(statusMsg, 'No active tab found', 'error'); return }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      await addImage(dataUrl, `screenshot-${Date.now()}.png`)
    } catch (err) {
      showStatus(statusMsg, `Screenshot failed: ${err.message}`, 'error')
    }
  })

  // Camera via getUserMedia
  let cameraStream = null
  const cameraOverlay   = document.getElementById('cameraOverlay')
  const cameraVideo     = document.getElementById('cameraVideo')
  const cameraCanvas    = document.getElementById('cameraCanvas')

  document.getElementById('cameraBtn').addEventListener('click', async () => {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      cameraVideo.srcObject = cameraStream
      cameraOverlay.classList.remove('hidden')
    } catch (err) {
      showStatus(statusMsg, `Camera error: ${err.message}`, 'error')
    }
  })

  document.getElementById('capturePhotoBtn').addEventListener('click', async () => {
    cameraCanvas.width  = cameraVideo.videoWidth
    cameraCanvas.height = cameraVideo.videoHeight
    cameraCanvas.getContext('2d').drawImage(cameraVideo, 0, 0)
    const dataUrl = cameraCanvas.toDataURL('image/jpeg', 0.9)
    stopCamera()
    await addImage(dataUrl, `photo-${Date.now()}.jpg`)
  })

  document.getElementById('closeCameraBtn').addEventListener('click', stopCamera)

  function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }
    cameraOverlay.classList.add('hidden')
  }

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter
  noteContent.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      sendBtn.click()
    }
  })

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden')
      document.getElementById('settingsPanel').classList.add('hidden')
      document.getElementById('bookmarksPanel').classList.add('hidden')
      if (btn.dataset.tab === 'entertainment') checkPendingEntCapture()
    })
  })

  initEntertainmentTab()
  initYoutubeTab()
})

function resetForm(noteContent, isTodo, noteTags) {
  noteContent.value = ''
  isTodo.checked = false
  noteTags.value = settings.defaultTags
  attachedImages = []
  renderImagePreviews()
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTERTAINMENT TRACKING
// ══════════════════════════════════════════════════════════════════════════════

async function getEntItems() {
  const { qc_entertainment = [] } = await chrome.storage.local.get('qc_entertainment')
  return qc_entertainment
}

async function saveEntItems(items) {
  await chrome.storage.local.set({ qc_entertainment: items })
}

function entId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

async function addEntItem(item) {
  const items = await getEntItems()
  const newItem = { ...item, id: entId(), addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  items.unshift(newItem)
  await saveEntItems(items)
  return items
}

async function updateEntItem(id, patch) {
  const items = await getEntItems()
  const idx = items.findIndex(i => i.id === id)
  if (idx !== -1) items[idx] = { ...items[idx], ...patch, updatedAt: new Date().toISOString() }
  await saveEntItems(items)
  return items
}

async function deleteEntItem(id) {
  const items = (await getEntItems()).filter(i => i.id !== id)
  await saveEntItems(items)
  return items
}

async function syncEntToLogseq(item, action) {
  const logContent = formatEntLogContent(item, action)
  try {
    const rootBlockUuid = await upsertEntRootBlock(item)
    if (logContent) {
      await callLogseqApi(
        'logseq.Editor.appendBlock',
        [rootBlockUuid, logContent, false],
        settings.apiPort,
        settings.authToken
      )
    }
  } catch {
    await pushToQueue({
      kind: 'ent-sync',
      entItem: item,
      action,
      timestamp: new Date().toISOString(),
    })
  }
}

const ENT_TYPE_ICONS    = { movie: '🎬', series: '📺' }

function renderEntList(items, filter, searchQuery) {
  const list = document.getElementById('entList')
  let filtered = items.map((item) => ({ ...item, status: normalizeEntStatus(item.status) }))
  if (filter && filter !== 'all') filtered = filtered.filter(i => i.status === filter)
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter(i => i.title.toLowerCase().includes(q))
  }
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-hint" style="margin:16px 0">Nothing here yet. Add something to watch!</div>'
    return 0
  }
  list.innerHTML = filtered.map(item => {
    const poster = item.posterUrl
      ? `<img src="${item.posterUrl}" alt="${item.title} poster" class="ent-poster" />`
      : `<div class="ent-poster ent-poster-fallback">${ENT_TYPE_ICONS[item.type]}</div>`
    const titleDisplay = item.url
      ? `<a class="ent-title-link" data-path="${item.url}" href="#" title="Open on current site">${item.title}</a>`
      : `<span class="ent-title-link">${item.title}</span>`
    const progress = (item.type === 'series' && item.status !== 'watched')
      ? `<span class="ent-progress">S${item.season}·E${item.episode}</span>` : ''
    const doneBtn = item.status !== 'watched'
      ? `<button class="ent-action-btn" data-action="watched" data-id="${item.id}" data-type="${item.type}" title="${item.type === 'series' ? 'Next / Watched' : 'Mark watched'}">${item.type === 'series' ? '⏭️' : '✅'}</button>` : ''
    return `<div class="ent-card">
      ${poster}
      <div class="ent-card-body">
        <div class="ent-card-title">${titleDisplay}${progress}</div>
        <span class="ent-status-badge ent-status-${item.status}">${getEntStatusLabel(item.status)}</span>
      </div>
      <div class="ent-card-actions">
        ${doneBtn}
        <button class="ent-action-btn" data-action="edit" data-id="${item.id}" title="Edit">✏️</button>
        <button class="ent-action-btn" data-action="del"  data-id="${item.id}" title="Remove">🗑️</button>
      </div>
    </div>`
  }).join('')
  list.querySelectorAll('.ent-action-btn').forEach(btn => {
    btn.addEventListener('click', () => entCardAction(btn.dataset.action, btn.dataset.id, btn.dataset.type))
  })
  list.querySelectorAll('.ent-title-link[data-path]').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault()
      const path = link.dataset.path
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        const origin = tab?.url ? new URL(tab.url).origin : null
        chrome.tabs.create({ url: origin ? origin + path : path })
      } catch {
        chrome.tabs.create({ url: path })
      }
    })
  })
  return filtered.length
}

function showEntForm(prefill = {}) {
  document.getElementById('entAddForm').classList.remove('hidden')
  if (prefill.title) {
    document.getElementById('entTitle').value = prefill.title
    const type = document.querySelector('[name="entType"]:checked')?.value || 'movie'
    triggerPosterSearch(prefill.title, type)
  }
  if (prefill.url) document.getElementById('entUrl').value = extractUrlPath(prefill.url)
  document.getElementById('entStatus').value = normalizeEntStatus(prefill.status || 'watching')
}

function hideEntForm() {
  selectedPosterUrl = null
  selectedYear = null
  clearTimeout(posterSearchTimer)
  const picker = document.getElementById('entPosterPicker')
  if (picker) { picker.classList.add('hidden'); picker.innerHTML = '' }
  document.getElementById('entAddForm').classList.add('hidden')
  ;['entTitle', 'entUrl', 'entEditId'].forEach(id => { document.getElementById(id).value = '' })
  document.getElementById('entStatus').value = 'watching'
  const movieRadio = document.querySelector('[name="entType"][value="movie"]')
  if (movieRadio) movieRadio.checked = true
  document.getElementById('entSeriesFields').classList.add('hidden')
  document.getElementById('entSeason').value  = 1
  document.getElementById('entEpisode').value = 1
}

function seriesPrompt(item) {
  return new Promise(resolve => {
    const el = document.createElement('div')
    el.className = 'series-prompt'
    el.innerHTML = `
      <div class="series-prompt-title">📺 "${item.title}"</div>
      <div class="series-prompt-desc">What happened?</div>
      <button data-c="episode">⏭️ Next Episode (S${item.season}E${item.episode + 1})</button>
      <button data-c="season">📂 Next Season (S${item.season + 1}E1)</button>
      <button data-c="watched">✅ Finished Series</button>
      <button data-c="cancel" class="btn-link" style="margin-top:4px">Cancel</button>`
    document.getElementById('entList').prepend(el)
    el.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => { el.remove(); resolve(b.dataset.c) })
    )
  })
}

async function entCardAction(action, id, type) {
  const items = await getEntItems()
  const item  = items.find(i => i.id === id)
  if (!item) return
  const activeFilter = document.querySelector('.ent-filter.active')?.dataset.filter || 'all'
  const search = document.getElementById('entSearch')?.value.trim() || ''

  if (action === 'watched') {
    if (type === 'series') {
      const choice = await seriesPrompt(item)
      if (!choice || choice === 'cancel') return
      if (choice === 'episode') {
        const upd = { episode: item.episode + 1 }
        await updateEntItem(id, upd)
        await syncEntToLogseq({ ...item, ...upd }, 'progress')
      } else if (choice === 'season') {
        const upd = { season: item.season + 1, episode: 1 }
        await updateEntItem(id, upd)
        await syncEntToLogseq({ ...item, ...upd }, 'progress')
      } else if (choice === 'watched') {
        await updateEntItem(id, { status: 'watched', watchedAt: new Date().toISOString() })
        await syncEntToLogseq({ ...item, status: 'watched' }, 'watched')
      }
    } else {
      await updateEntItem(id, { status: 'watched', watchedAt: new Date().toISOString() })
      await syncEntToLogseq({ ...item, status: 'watched' }, 'watched')
    }
  } else if (action === 'edit') {
    selectedPosterUrl = item.posterUrl || null
    selectedYear = item.year || null
    document.getElementById('entTitle').value  = item.title
    document.getElementById('entUrl').value    = item.url || ''
    document.getElementById('entStatus').value = normalizeEntStatus(item.status)
    document.getElementById('entEditId').value = item.id
    const radio = document.querySelector(`[name="entType"][value="${item.type}"]`)
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')) }
    if (item.type === 'series') {
      document.getElementById('entSeason').value  = item.season  || 1
      document.getElementById('entEpisode').value = item.episode || 1
    }
    showEntForm()
    triggerPosterSearch(item.title, item.type)
    return
  } else if (action === 'del') {
    const updated = await deleteEntItem(id)
    renderEntList(updated, activeFilter, search)
    return
  }
  renderEntList(await getEntItems(), activeFilter, search)
}

async function checkPendingEntCapture() {
  const { qc_pending_ent } = await chrome.storage.local.get('qc_pending_ent')
  document.getElementById('entPendingCapture').classList.toggle('hidden', !qc_pending_ent)
}

function initEntertainmentTab() {
  let currentFilter = 'all'
  let suggestTimer = null

  async function renderNeodbSuggestions(searchQuery) {
    const list = document.getElementById('entList')
    list.innerHTML = '<div class="empty-hint" style="margin:16px 0">Nothing here yet. Add something to watch!</div><div class="empty-hint" style="margin-bottom:8px">Searching NeoDB suggestions…</div>'

    let suggestions = []
    try {
      suggestions = await fetchNeodbSuggestions(searchQuery)
    } catch {
      suggestions = []
    }

    if (document.getElementById('entSearch').value.trim() !== searchQuery) return
    if (suggestions.length === 0) return

    list.innerHTML = `
      <div class="empty-hint" style="margin:12px 0 8px">Nothing here yet. Add something to watch!</div>
      <div class="ent-suggest-title">NeoDB suggestions</div>
      ${suggestions.map((item, idx) => {
        const poster = item.posterUrl
          ? `<img src="${item.posterUrl}" alt="${item.title} poster" class="ent-poster" />`
          : `<div class="ent-poster ent-poster-fallback">${ENT_TYPE_ICONS[item.type]}</div>`
        const subtitle = `${item.type === 'series' ? 'series' : 'movie'}${item.year ? ' • ' + item.year : ''}`
        return `<div class="ent-card ent-suggest-card">
          ${poster}
          <div class="ent-card-body">
            <div class="ent-card-title">${item.title}</div>
            <span class="ent-suggest-subtitle">${subtitle}</span>
          </div>
          <div class="ent-card-actions">
            <button class="ent-action-btn ent-suggest-add" data-idx="${idx}" title="Add">➕</button>
          </div>
        </div>`
      }).join('')}
    `

    list.querySelectorAll('.ent-suggest-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const suggestion = suggestions[parseInt(btn.dataset.idx, 10)]
        if (!suggestion) return
        const added = await addEntItem({
          title: suggestion.title,
          type: suggestion.type,
          status: 'watching',
          season: 1,
          episode: 1,
          ...(suggestion.posterUrl ? { posterUrl: suggestion.posterUrl } : {}),
          ...(suggestion.year ? { year: suggestion.year } : {}),
        })
        await syncEntToLogseq(added[0], 'add')
        await refreshList()
      })
    })
  }

  async function refreshList() {
    const searchQuery = document.getElementById('entSearch').value.trim()
    const count = renderEntList(await getEntItems(), currentFilter, searchQuery)
    clearTimeout(suggestTimer)
    if (count === 0 && searchQuery) {
      suggestTimer = setTimeout(() => {
        renderNeodbSuggestions(searchQuery)
      }, 350)
    }
  }

  document.getElementById('entSearch').addEventListener('input', refreshList)

  document.querySelectorAll('.ent-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ent-filter').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentFilter = btn.dataset.filter
      refreshList()
    })
  })

  document.getElementById('entAddBtn').addEventListener('click', () => showEntForm())

  document.querySelectorAll('[name="entType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isSeries = document.querySelector('[name="entType"]:checked')?.value === 'series'
      document.getElementById('entSeriesFields').classList.toggle('hidden', !isSeries)
      const title = document.getElementById('entTitle').value.trim()
      if (title) triggerPosterSearch(title, isSeries ? 'series' : 'movie')
    })
  })

  document.getElementById('entTitle').addEventListener('input', () => {
    const title = document.getElementById('entTitle').value.trim()
    const type = document.querySelector('[name="entType"]:checked')?.value || 'movie'
    triggerPosterSearch(title, type)
  })

  document.getElementById('entUrl').addEventListener('blur', () => {
    const raw = document.getElementById('entUrl').value.trim()
    if (raw) document.getElementById('entUrl').value = extractUrlPath(raw)
  })

  document.getElementById('entSaveBtn').addEventListener('click', async () => {
    const title = document.getElementById('entTitle').value.trim()
    const formStatus = document.getElementById('entFormStatus')
    if (!title) { showStatus(formStatus, 'Title is required', 'error'); return }
    const type   = document.querySelector('[name="entType"]:checked').value
    const editId = document.getElementById('entEditId').value

    let posterUrl = selectedPosterUrl
    let year = selectedYear
    if (!posterUrl) {
      try {
        const results = settings.tmdbApiKey
          ? await fetchTmdbResults(title, type, settings.tmdbApiKey)
          : await fetchNeodbPosterOptions(title, type)
        if (results[0]) { posterUrl = results[0].posterUrl; year = results[0].year }
      } catch { /* poster is optional */ }
    }

    const itemData = {
      title,
      type,
      url:     extractUrlPath(document.getElementById('entUrl').value.trim()),
      status:  normalizeEntStatus(document.getElementById('entStatus').value),
      season:  parseInt(document.getElementById('entSeason').value,  10) || 1,
      episode: parseInt(document.getElementById('entEpisode').value, 10) || 1,
      ...(posterUrl ? { posterUrl } : {}),
      ...(year ? { year } : {}),
    }
    let updatedItems
    if (editId) {
      updatedItems = await updateEntItem(editId, itemData)
      const updatedItem = updatedItems.find((entry) => entry.id === editId)
      if (updatedItem) await syncEntToLogseq(updatedItem, 'root-update')
    } else {
      updatedItems = await addEntItem(itemData)
      await syncEntToLogseq(updatedItems[0], 'add')
    }
    hideEntForm()
    renderEntList(updatedItems, currentFilter, document.getElementById('entSearch').value.trim())
    showStatus(formStatus, '', '')
  })

  document.getElementById('entCancelBtn').addEventListener('click', hideEntForm)

  document.getElementById('fillFromCapture').addEventListener('click', async () => {
    const { qc_pending_ent } = await chrome.storage.local.get('qc_pending_ent')
    if (!qc_pending_ent) return
    showEntForm({ title: qc_pending_ent.title, url: qc_pending_ent.url })
    await chrome.storage.local.remove('qc_pending_ent')
    document.getElementById('entPendingCapture').classList.add('hidden')
  })

  checkPendingEntCapture()
  refreshList()
}

// ══════════════════════════════════════════════════════════════════════════════
// YOUTUBE CHANNEL FETCHER
// ══════════════════════════════════════════════════════════════════════════════

let ytVideos = []

function parseChannelInput(input) {
  input = input.trim()
  if (input.startsWith('@')) return { type: 'handle', value: input }
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0]?.startsWith('@'))          return { type: 'handle',    value: parts[0] }
    if (parts[0] === 'channel' && parts[1]) return { type: 'id',        value: parts[1] }
    if (parts[0] === 'c'       && parts[1]) return { type: 'customUrl', value: parts[1] }
    if (parts[0] === 'user'    && parts[1]) return { type: 'username',  value: parts[1] }
  } catch { /* not a URL */ }
  return { type: 'handle', value: `@${input}` }
}

async function getUploadsPlaylistId(channel, apiKey) {
  const params = new URLSearchParams({ part: 'contentDetails', key: apiKey })
  if      (channel.type === 'id')        params.set('id',          channel.value)
  else if (channel.type === 'handle')    params.set('forHandle',   channel.value)
  else if (channel.type === 'username')  params.set('forUsername', channel.value)
  else if (channel.type === 'customUrl') params.set('forHandle',   `@${channel.value}`)
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`)
  if (!res.ok) throw new Error(`YouTube API: ${res.status}`)
  const data = await res.json()
  const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsId) throw new Error('Channel not found or has no uploads playlist')
  return uploadsId
}

async function fetchPlaylistItems(playlistId, apiKey, maxVideos = 200) {
  const videos = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({ part: 'snippet', maxResults: 50, playlistId, key: apiKey })
    if (pageToken) params.set('pageToken', pageToken)
    const res  = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`)
    if (!res.ok) throw new Error(`YouTube API: ${res.status}`)
    const data = await res.json()
    for (const item of data.items || []) {
      const vid = item.snippet?.resourceId?.videoId
      if (vid) videos.push({
        videoId: vid,
        title:   item.snippet.title,
        url:     `https://youtube.com/watch?v=${vid}`,
        thumb:   item.snippet.thumbnails?.default?.url || '',
      })
    }
    pageToken = data.nextPageToken || ''
  } while (pageToken && videos.length < maxVideos)
  return videos
}

function renderYtList(videos) {
  document.getElementById('ytVideoCount').textContent = `${videos.length} videos`
  document.getElementById('ytVideoList').innerHTML = videos.map((v, i) => `
    <div class="yt-video-item">
      <span class="yt-video-num">${i + 1}</span>
      ${v.thumb ? `<img src="${v.thumb}" class="yt-thumb" alt="" />` : ''}
      <a href="${v.url}" target="_blank" class="yt-video-title">${v.title}</a>
    </div>`).join('')
}

async function aiSequenceVideos(videos, openAiKey) {
  const titles = videos.map((v, i) => `${i}: ${v.title}`).join('\n')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Below are YouTube video titles from one channel with 0-based indices.\nReorder them into the most logical viewing sequence (beginner→advanced or project chronological order).\nReturn ONLY a JSON array of the 0-based indices in the new order — no other text.\n\n${titles}`,
      }],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API: ${res.status}`)
  const data  = await res.json()
  const raw   = data.choices?.[0]?.message?.content?.trim() || ''
  const match = raw.match(/\[[\d,\s]+\]/)
  if (!match) throw new Error('Could not parse AI response')
  return JSON.parse(match[0]).map(i => videos[i]).filter(Boolean)
}

function initYoutubeTab() {
  const ytStatus  = document.getElementById('ytStatus')
  const ytResults = document.getElementById('ytResults')

  document.getElementById('ytFetchBtn').addEventListener('click', async () => {
    const input = document.getElementById('ytChannel').value.trim()
    if (!input) { showStatus(ytStatus, 'Enter a channel URL or @handle', 'error'); return }
    const { qc_settings = {} } = await chrome.storage.local.get('qc_settings')
    const apiKey = qc_settings.ytApiKey || ''
    if (!apiKey) { showStatus(ytStatus, 'YouTube API key missing — add it in ⚙️ Settings', 'error'); return }
    document.getElementById('ytFetchBtn').disabled = true
    showStatus(ytStatus, 'Fetching videos…', 'info')
    try {
      const channel   = parseChannelInput(input)
      const uploadsId = await getUploadsPlaylistId(channel, apiKey)
      ytVideos        = await fetchPlaylistItems(uploadsId, apiKey)
      renderYtList(ytVideos)
      ytResults.classList.remove('hidden')
      showStatus(ytStatus, `✓ Loaded ${ytVideos.length} videos`, 'success')
    } catch (err) {
      showStatus(ytStatus, `Error: ${err.message}`, 'error')
    } finally {
      document.getElementById('ytFetchBtn').disabled = false
    }
  })

  document.getElementById('ytCopyBtn').addEventListener('click', async () => {
    if (!ytVideos.length) return
    await navigator.clipboard.writeText(ytVideos.map((v, i) => `${i + 1}. [${v.title}](${v.url})`).join('\n'))
    showStatus(ytStatus, '✓ Copied to clipboard', 'success')
  })

  document.getElementById('ytLogseqBtn').addEventListener('click', async () => {
    if (!ytVideos.length) return
    const channel = document.getElementById('ytChannel').value.trim()
    try {
      await sendToLogseq(`## ${channel}`, 'YouTube Channels', settings.apiPort, settings.authToken)
      for (const v of ytVideos) {
        await sendToLogseq(`[${v.title}](${v.url})`, 'YouTube Channels', settings.apiPort, settings.authToken)
      }
      showStatus(ytStatus, `✓ Sent ${ytVideos.length} videos to Logseq`, 'success')
    } catch {
      showStatus(ytStatus, 'Logseq offline — check connection', 'error')
    }
  })

  document.getElementById('ytAiBtn').addEventListener('click', async () => {
    if (!ytVideos.length) { showStatus(ytStatus, 'Fetch videos first', 'error'); return }
    const { qc_settings = {} } = await chrome.storage.local.get('qc_settings')
    const openAiKey = qc_settings.openAiKey || ''
    if (!openAiKey) { showStatus(ytStatus, 'OpenAI API key missing — add it in ⚙️ Settings', 'error'); return }
    document.getElementById('ytAiBtn').disabled = true
    showStatus(ytStatus, '🤖 AI is sequencing…', 'info')
    try {
      ytVideos = await aiSequenceVideos(ytVideos, openAiKey)
      renderYtList(ytVideos)
      showStatus(ytStatus, '✓ Videos reordered by AI', 'success')
    } catch (err) {
      showStatus(ytStatus, `AI error: ${err.message}`, 'error')
    } finally {
      document.getElementById('ytAiBtn').disabled = false
    }
  })
}
