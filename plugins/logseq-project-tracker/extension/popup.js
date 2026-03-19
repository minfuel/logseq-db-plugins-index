// popup.js — Logseq Project Tracker

// ── Defaults & state ──────────────────────────────────────────────────────────

const DEFAULTS = {
  apiPort: 12315,
  authToken: '',
  programProperty: 'program',
}

const RDS_81346 = {
  pageName: 'RDS/81346 #Project',
  programName: 'RDS',
  projectId: 'RDS-81346',
  starterBlocks: [
    'project-id:: RDS-81346',
    '#request Define implementation scope for RDS 81346',
    '#event Kickoff created from Project Tracker',
    '#news Progress updates for RDS 81346 go here',
    '## Checklist',
    '- TODO Confirm requirements',
    '- TODO Build first milestone',
  ],
}

let settings    = { ...DEFAULTS }
let projects    = []       // all #project pages from Logseq
let feedItems   = []       // all news/event/request blocks
let feedFilter  = 'all'    // current feed filter
let expandedPage = null    // currently expanded project page name
let projectBlocks = []     // blocks for the expanded project
const createdPrograms = new Set()
let discoveredPrograms = new Set()

// ── API helper ────────────────────────────────────────────────────────────────

async function callLogseqApi(method, args) {
  const headers = { 'Content-Type': 'application/json' }
  if (settings.authToken) headers['Authorization'] = `Bearer ${settings.authToken}`

  let response
  try {
    response = await fetch(`http://localhost:${settings.apiPort}/api`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, args }),
    })
  } catch (error) {
    throw new Error('network error: start Logseq and enable HTTP API server')
  }

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

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchProjects() {
  const [allPagesRaw, projectBlocks, programBlocks] = await Promise.all([
    callLogseqApi('logseq.Editor.getAllPages', []),
    fetchBlocksByHashtag('project'),
    fetchBlocksByHashtag('program'),
  ])

  const allPages = normalizePagesFromGetAll(allPagesRaw)
  const projectFromPageTitle = allPages.filter((p) => pageTitleHasTag(p, 'project'))
  const programFromPageTitle = allPages.filter((p) => pageTitleHasTag(p, 'program'))

  const projectFromBlocks = projectBlocks.map(tupleToPageEntity).filter(Boolean)
  const programFromBlocks = programBlocks.map(tupleToPageEntity).filter(Boolean)

  const projectPages = dedupePages([...projectFromPageTitle, ...projectFromBlocks])
  const programPages = dedupePages([...programFromPageTitle, ...programFromBlocks])

  discoveredPrograms = new Set(
    programPages
      .map((p) => p['block/original-name'] || p['block/name'])
      .filter(Boolean)
  )

  return projectPages
}

async function fetchBlocksByHashtag(tagName) {
  const query = `[:find (pull ?b [:block/uuid :block/content :block/updated-at {:block/page [:block/original-name :block/name :block/uuid :block/properties :block/updated-at]}])
    :where
    [?b :block/content ?c]
    [(re-find #"(?i)(^|\\s)#${tagName}\\b" ?c)]]`

  const result = await callLogseqApi('logseq.DB.datascriptQuery', [query])
  return Array.isArray(result) ? result : []
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

function pageTitleHasTag(page, tagName) {
  const title = String(page['block/original-name'] || page['block/name'] || '')
  const rx = new RegExp(`(^|\\s)#${tagName}\\b`, 'i')
  return rx.test(title)
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

async function fetchFeedItems() {
  const types = [
    { name: 'news',    icon: '📰' },
    { name: 'event',   icon: '📅' },
    { name: 'request', icon: '🔔' },
  ]

  let all = []

  for (const { name, icon } of types) {
    const query = `[:find (pull ?b [:block/content :block/uuid :block/updated-at {:block/page [:block/original-name]}])
      :where
      [?b :block/tags ?t]
      [?t :block/title "${name}"]]`

    try {
      const result = await callLogseqApi('logseq.DB.datascriptQuery', [query])
      const items = (result || [])
        .map(r => ({ ...r[0], _type: name, _icon: icon }))
        .filter(Boolean)
      all = all.concat(items)
    } catch {
      // skip this type if query fails
    }
  }

  all.sort((a, b) => (b['block/updated-at'] || 0) - (a['block/updated-at'] || 0))
  return all
}

async function fetchProjectBlocks(pageName) {
  const result = await callLogseqApi('logseq.Editor.getPageBlocksTree', [pageName])
  return Array.isArray(result) ? result : []
}

async function navigateToPage(pageName) {
  try {
    await callLogseqApi('logseq.App.pushState', ['page', { name: pageName }])
  } catch {
    // ignore — Logseq may still open the page
  }
  window.close()
}

async function appendToProject(pageName, content) {
  await callLogseqApi('logseq.Editor.appendBlockInPage', [pageName, content])
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProjectDisplayName(project) {
  const name = project['block/original-name'] || project['block/name'] || ''
  // If namespaced (e.g. "programs/project-name"), return only the last segment
  const leaf = name.includes('/') ? name.split('/').pop() : name
  return String(leaf).replace(/\s+#project$/i, '').trim()
}

function getProgram(project) {
  const prop = settings.programProperty || 'program'

  // Check Logseq page properties
  const props = project['block/properties']
  if (props) {
    const val = props[prop] || props[prop.toLowerCase()]
    if (val) return Array.isArray(val) ? val[0] : String(val)
  }

  // Fall back to namespace prefix (e.g. "programs/project" → "programs")
  const name = project['block/original-name'] || project['block/name'] || ''
  if (name.includes('/')) return name.split('/').slice(0, -1).join('/')

  return null
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

function isProjectPage(page) {
  const title = String(page['block/original-name'] || page['block/name'] || '')
  const lower = title.toLowerCase()
  if (/#project\b/.test(lower)) return true

  // Treat namespaced pages under programs as project pages.
  // Examples: "programs/Fuel/App" or "programs/Fuel #Project"
  if (lower.startsWith('programs/')) return true

  const propName = (settings.programProperty || 'program').toLowerCase()
  const props = page['block/properties'] || {}
  return Boolean(props[propName] || props[settings.programProperty || 'program'])
}

function normalizeName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ')
}

function normalizePath(raw) {
  return String(raw || '')
    .split('/')
    .map((s) => normalizeName(s).replace(/#/g, ''))
    .filter(Boolean)
    .join('/')
}

function getKnownPrograms() {
  const set = new Set([...createdPrograms, ...discoveredPrograms])
  for (const project of projects) {
    const program = getProgram(project)
    if (program) set.add(program)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

function updateProgramSelect() {
  const select = document.getElementById('projectProgramSelect')
  if (!select) return

  const programs = getKnownPrograms()
  if (!programs.length) {
    select.innerHTML = '<option value="">No programs yet</option>'
    return
  }

  select.innerHTML = programs
    .map((program) => `<option value="${escapeAttr(program)}">${escapeHtml(program)}</option>`)
    .join('')
}

function showCreateStatus(message, type = 'info') {
  const el = document.getElementById('createStatus')
  if (!el) return
  el.textContent = message
  el.className = `statusbar ${type}`
  el.classList.remove('hidden')
  setTimeout(() => el.classList.add('hidden'), 2200)
}

async function createProgram() {
  const input = document.getElementById('newProgramName')
  const normalized = normalizePath(input.value)
  if (!normalized) {
    showCreateStatus('Program name is required', 'error')
    return
  }

  const pageName = normalized.includes('/') ? normalized : `programs/${normalized}`
  await callLogseqApi('logseq.Editor.createPage', [pageName, {}, { redirect: false }])

  createdPrograms.add(pageName)
  updateProgramSelect()
  input.value = ''
  showCreateStatus('Program created ✓', 'success')
}

async function createProject() {
  const programSelect = document.getElementById('projectProgramSelect')
  const projectInput = document.getElementById('newProjectName')

  const programName = normalizePath(programSelect.value)
  const projectName = normalizeName(projectInput.value).replace(/[\/]/g, ' ')

  if (!programName) {
    showCreateStatus('Choose or create a program first', 'error')
    return
  }
  if (!projectName) {
    showCreateStatus('Project name is required', 'error')
    return
  }

  const pageName = `${programName}/${projectName} #Project`
  const projectProps = {
    [settings.programProperty]: programName,
  }

  const created = await callLogseqApi('logseq.Editor.createPage', [pageName, projectProps, { redirect: false }])

  // Optimistic local insert to avoid an immediate re-fetch.
  const now = Date.now()
  projects.unshift({
    'block/original-name': created?.['block/original-name'] || pageName,
    'block/name': created?.['block/name'] || pageName.toLowerCase(),
    'block/uuid': created?.['block/uuid'] || `local-${now}`,
    'block/updated-at': created?.['block/updated-at'] || now,
    'block/properties': created?.['block/properties'] || projectProps,
  })

  createdPrograms.add(programName)
  updateProgramSelect()
  renderProjectList(filterProjectList(currentSearch()))
  projectInput.value = ''
  showCreateStatus('Project created ✓', 'success')
}

async function createOrOpenRds81346Project() {
  const pageProperty = settings.programProperty || 'program'
  const pageName = RDS_81346.pageName
  const pageProps = {
    [pageProperty]: RDS_81346.programName,
    project_id: RDS_81346.projectId,
  }

  let existingPage = null
  try {
    existingPage = await callLogseqApi('logseq.Editor.getPage', [pageName])
  } catch {
    existingPage = null
  }

  await callLogseqApi('logseq.Editor.createPage', [pageName, pageProps, { redirect: false, createFirstBlock: false }])

  if (!existingPage) {
    for (const line of RDS_81346.starterBlocks) {
      await callLogseqApi('logseq.Editor.appendBlockInPage', [pageName, line])
    }
  }

  createdPrograms.add(RDS_81346.programName)
  discoveredPrograms.add(RDS_81346.programName)

  projects = await fetchProjects()
  renderProjectList(filterProjectList(currentSearch()))
  updateProgramSelect()

  showCreateStatus(
    existingPage ? 'RDS 81346 already exists — opened ✓' : 'RDS 81346 created ✓',
    'success'
  )

  await navigateToPage(pageName)
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000)          return 'just now'
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 2_592_000_000)   return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString()
}

function stripMarkdown(text) {
  return (text || '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')   // [[page links]] → page
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [label](url) → label
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // images → remove
    .replace(/#[a-zA-Z0-9_/-]+/g, '')       // #tags → remove
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')          // *italic* → italic
    .replace(/`([^`]+)`/g, '$1')            // `code` → code
    .replace(/^\s*[-*>]\s+/gm, '')          // leading bullets/blockquotes
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text, n = 90) {
  const clean = stripMarkdown(text)
  return clean.length > n ? clean.slice(0, n) + '…' : clean
}

// Security helpers — prevent XSS in dynamic innerHTML
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function escapeAttr(text) {
  return String(text || '').replace(/"/g, '&quot;')
}

function showStatus(msg, type = 'info') {
  const el = document.getElementById('statusbar')
  el.textContent = msg
  el.className = `statusbar ${type}`
  el.classList.remove('hidden')
  if (type !== 'error') {
    setTimeout(() => el.classList.add('hidden'), 3000)
  }
}

function currentSearch() {
  return document.getElementById('searchInput').value.trim().toLowerCase()
}

function filterProjectList(query) {
  if (!query) return projects
  return projects.filter(p => {
    const name = getProjectDisplayName(p).toLowerCase()
    const prog = (getProgram(p) || '').toLowerCase()
    const full = (p['block/original-name'] || '').toLowerCase()
    return name.includes(query) || prog.includes(query) || full.includes(query)
  })
}

// ── Rendering: Projects ───────────────────────────────────────────────────────

function renderProjectList(filtered) {
  const container = document.getElementById('projectList')
  const summary   = document.getElementById('projectSummary')

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-hint">No projects found.<br>Make sure Logseq is running and items use <strong>#project</strong> / <strong>#Project</strong> tags.</div>`
    summary.classList.add('hidden')
    return
  }

  // Sort by updated-at descending
  const sorted = [...filtered].sort((a, b) => (b['block/updated-at'] || 0) - (a['block/updated-at'] || 0))

  // Group by program
  const groups = {}
  for (const p of sorted) {
    const prog = getProgram(p) || '—'
    if (!groups[prog]) groups[prog] = []
    groups[prog].push(p)
  }

  // Update summary
  summary.textContent = `${filtered.length} project${filtered.length !== 1 ? 's' : ''} · ${Object.keys(groups).length} program${Object.keys(groups).length !== 1 ? 's' : ''}`
  summary.classList.remove('hidden')

  container.innerHTML = sorted.map(p => renderProjectItem(p)).join('')

  // Bind header click (expand/collapse)
  container.querySelectorAll('.project-header').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.btn-icon')) return
      toggleProject(el.closest('.project-item').dataset.page)
    })
  })

  // Bind open-in-Logseq buttons
  container.querySelectorAll('.btn-open-project').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      await navigateToPage(btn.dataset.page)
    })
  })

  // Re-bind thread controls if a project is expanded
  if (expandedPage) {
    bindThreadControls(expandedPage)
  }
}

function renderProjectItem(p) {
  const name    = p['block/original-name'] || p['block/name'] || 'Unknown'
  const display = getProjectDisplayName(p)
  const program = getProgram(p)
  const ts      = timeAgo(p['block/updated-at'])
  const isOpen  = expandedPage === name

  return `
    <div class="project-item${isOpen ? ' expanded' : ''}" data-page="${escapeAttr(name)}">
      <div class="project-header">
        <div class="project-info">
          <span class="project-name">${escapeHtml(display)}</span>
          ${program ? `<span class="project-program">${escapeHtml(program)}</span>` : ''}
        </div>
        <div class="project-actions">
          ${ts ? `<span class="project-time">${escapeHtml(ts)}</span>` : ''}
          <button class="btn-icon btn-open-project" data-page="${escapeAttr(name)}" title="Open in Logseq">↗</button>
        </div>
      </div>
      ${isOpen ? renderThreadsPanel() : ''}
    </div>
  `
}

function renderThreadsPanel() {
  if (projectBlocks === null) {
    // Still loading
    return `<div class="threads-panel"><div class="empty-hint">Loading…</div></div>`
  }

  const top = projectBlocks.slice(0, 12)

  return `
    <div class="threads-panel">
      <div class="threads-header">Recent blocks</div>
      <div class="threads-list">
        ${top.length ? top.map(b => renderBlock(b, 0)).join('') : '<div class="empty-hint">No blocks on this page yet.</div>'}
      </div>
      <div class="thread-add">
        <textarea id="threadInput" class="thread-textarea" placeholder="Add a note to this project… (Enter to send)" rows="2"></textarea>
        <button id="threadSend" class="btn-primary-sm">Add</button>
      </div>
      <div id="threadAddSuccess" class="thread-more hidden">Added ✓</div>
    </div>
  `
}

function renderBlock(block, depth) {
  if (depth > 2 || !block) return ''

  const content    = truncate(block.content, 130)
  if (!content)    return ''

  const children   = block.children || []
  const childCount = children.length

  // Heuristic: detect AI vs user messages for visual distinction
  const raw     = (block.content || '').toLowerCase()
  const isAi    = /^(ai|assistant|gpt|claude|copilot)[:：]/.test(raw)
  const isUser  = /^(user|human|me|you)[:：]/.test(raw) || /^q[:：]/.test(raw)
  const prefix  = isAi ? '🤖 ' : isUser ? '👤 ' : ''

  let childrenHtml = ''
  if (depth < 2 && childCount > 0) {
    const shown = children.slice(0, 4)
    const extra = childCount - shown.length
    childrenHtml = `
      <details>
        <summary>${childCount} repl${childCount !== 1 ? 'ies' : 'y'} ▸</summary>
        ${shown.map(c => renderBlock(c, depth + 1)).join('')}
        ${extra > 0 ? `<div class="thread-more">+${extra} more…</div>` : ''}
      </details>`
  }

  return `
    <div class="thread-block depth-${depth}">
      <div class="thread-content">${prefix}${escapeHtml(content)}</div>
      ${childrenHtml}
    </div>
  `
}

// ── Rendering: Feed ───────────────────────────────────────────────────────────

function renderFeed(items) {
  const container = document.getElementById('feedList')

  const visible = feedFilter === 'all'
    ? items
    : items.filter(i => i._type === feedFilter)

  if (!visible.length) {
    container.innerHTML = `<div class="empty-hint">No ${feedFilter === 'all' ? '' : feedFilter + ' '}items found.<br>Tag blocks with <strong>#news</strong>, <strong>#event</strong>, or <strong>#request</strong> in your project pages.</div>`
    return
  }

  container.innerHTML = visible.slice(0, 40).map(item => {
    const content  = truncate(item['block/content'], 110)
    const pageName = item['block/page']?.['block/original-name'] || ''
    const display  = pageName.includes('/') ? pageName.split('/').pop() : pageName
    const ts       = timeAgo(item['block/updated-at'])

    return `
      <div class="feed-item feed-type-${escapeAttr(item._type)}" data-page="${escapeAttr(pageName)}">
        <div class="feed-icon">${item._icon || '•'}</div>
        <div class="feed-body">
          <div class="feed-meta">
            <span class="feed-project">${escapeHtml(display || '—')}</span>
            <span class="feed-tag">#${escapeHtml(item._type)}</span>
            ${ts ? `<span class="feed-time">${escapeHtml(ts)}</span>` : ''}
          </div>
          <div class="feed-content">${escapeHtml(content)}</div>
        </div>
        ${pageName ? `<button class="btn-open-feed" data-page="${escapeAttr(pageName)}" title="Open in Logseq">↗</button>` : ''}
      </div>
    `
  }).join('')

  container.querySelectorAll('.btn-open-feed').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      await navigateToPage(btn.dataset.page)
    })
  })

  container.querySelectorAll('.feed-item').forEach(item => {
    item.addEventListener('click', async e => {
      if (e.target.closest('.btn-open-feed')) return
      const page = item.dataset.page
      if (page) await navigateToPage(page)
    })
  })
}

// ── Project expand / collapse ─────────────────────────────────────────────────

async function toggleProject(pageName) {
  if (expandedPage === pageName) {
    // Collapse
    expandedPage  = null
    projectBlocks = []
    renderProjectList(filterProjectList(currentSearch()))
    return
  }

  // Expand — show loading state first
  expandedPage  = pageName
  projectBlocks = null // null = loading
  renderProjectList(filterProjectList(currentSearch()))

  try {
    projectBlocks = await fetchProjectBlocks(pageName)
  } catch (err) {
    showStatus(`Could not load blocks: ${err.message}`, 'error')
    projectBlocks = []
  }

  renderProjectList(filterProjectList(currentSearch()))
  bindThreadControls(pageName)
}

function bindThreadControls(pageName) {
  const sendBtn = document.getElementById('threadSend')
  const input   = document.getElementById('threadInput')
  const success = document.getElementById('threadAddSuccess')
  if (!sendBtn || !input) return

  let successTimer = null

  function showInlineSuccess() {
    if (!success) return
    success.textContent = 'Added ✓'
    success.classList.remove('hidden')
    if (successTimer) clearTimeout(successTimer)
    successTimer = setTimeout(() => {
      success.classList.add('hidden')
    }, 1800)
  }

  async function doSend() {
    const content = input.value.trim()
    if (!content) return

    sendBtn.disabled = true
    try {
      await appendToProject(pageName, content)
      input.value = ''
      showStatus('Note added ✓', 'success')

      // Optimistic local insert: avoid an extra API call after successful append.
      if (!Array.isArray(projectBlocks)) {
        projectBlocks = []
      }
      projectBlocks.unshift({ content, children: [] })

      renderProjectList(filterProjectList(currentSearch()))
      bindThreadControls(pageName)
      showInlineSuccess()
    } catch (err) {
      showStatus('Failed to add note: ' + err.message, 'error')
      sendBtn.disabled = false
      if (success) {
        success.textContent = 'Add failed'
        success.classList.remove('hidden')
      }
      return
    }

    sendBtn.disabled = false
  }

  sendBtn.addEventListener('click', doSend)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  })
}

// ── Load & render all data ────────────────────────────────────────────────────

async function loadAndRender(showSpinner = true) {
  const spinner = document.getElementById('loadingSpinner')

  if (showSpinner) spinner.classList.remove('hidden')

  // Show cached data immediately for a snappy UX
  try {
    const { pt_projects_cache = [], pt_feed_cache = [], pt_last_refresh } =
      await chrome.storage.local.get(['pt_projects_cache', 'pt_feed_cache', 'pt_last_refresh'])

    if (pt_projects_cache.length) {
      projects = pt_projects_cache
      renderProjectList(filterProjectList(currentSearch()))
      updateProgramSelect()
    }
    if (pt_feed_cache.length) {
      feedItems = pt_feed_cache
      renderFeed(feedItems)
    }
    if (pt_last_refresh) {
      document.getElementById('lastRefreshTime').textContent = timeAgo(pt_last_refresh)
    }
  } catch {
    // ignore cache errors
  }

  // Fetch fresh from Logseq
  try {
    const [freshProjects, freshFeed] = await Promise.all([
      fetchProjects(),
      fetchFeedItems(),
    ])

    projects  = freshProjects
    feedItems = freshFeed

    await chrome.storage.local.set({
      pt_projects_cache: projects,
      pt_feed_cache:     feedItems.slice(0, 60),
      pt_last_refresh:   Date.now(),
    })

    // Clear badge — user is looking at the data now
    chrome.action.setBadgeText({ text: '' })

    renderProjectList(filterProjectList(currentSearch()))
    updateProgramSelect()
    renderFeed(feedItems)
    document.getElementById('lastRefreshTime').textContent = 'just now'
    showStatus(`Found ${projects.length} projects, ${getKnownPrograms().length} programs`, 'info')
  } catch (err) {
    const reason = err?.message ? ` (${err.message})` : ''
    showStatus(`Cannot reach Logseq${reason}. Showing cached data.`, 'error')
  } finally {
    spinner.classList.add('hidden')
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { pt_settings = {} } = await chrome.storage.local.get('pt_settings')
  settings = { ...DEFAULTS, ...pt_settings }

  document.getElementById('apiPort').value          = settings.apiPort
  document.getElementById('authToken').value        = settings.authToken
  document.getElementById('programProperty').value  = settings.programProperty
}

async function saveSettingsFromForm() {
  const portRaw = parseInt(document.getElementById('apiPort').value, 10)
  const token   = document.getElementById('authToken').value.trim()
  const prop    = document.getElementById('programProperty').value.trim() || 'program'

  if (!portRaw || portRaw < 1 || portRaw > 65535) {
    showStatus('Port must be between 1 and 65535', 'error')
    return
  }

  settings = { apiPort: portRaw, authToken: token, programProperty: prop }
  await chrome.storage.local.set({ pt_settings: settings })

  showStatus('Settings saved', 'success')
  document.getElementById('settingsPanel').classList.add('hidden')
  await loadAndRender()
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings()
  await loadAndRender()

  // ── Settings panel ─────────────────────────────────────────────────────────
  document.getElementById('settingsToggle').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.toggle('hidden')
  })
  document.getElementById('saveSettings').addEventListener('click', saveSettingsFromForm)

  // ── Refresh button ─────────────────────────────────────────────────────────
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    expandedPage  = null
    projectBlocks = []
    await loadAndRender()
  })

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden')
    })
  })

  // ── Search ─────────────────────────────────────────────────────────────────
  document.getElementById('searchInput').addEventListener('input', e => {
    renderProjectList(filterProjectList(e.target.value.trim().toLowerCase()))
  })

  // ── Create program / project panel ────────────────────────────────────────
  document.getElementById('toggleCreatePanel').addEventListener('click', () => {
    document.getElementById('createPanel').classList.toggle('hidden')
  })

  document.getElementById('createRdsProjectBtn').addEventListener('click', async () => {
    try {
      await createOrOpenRds81346Project()
    } catch (err) {
      showCreateStatus(`Could not open RDS 81346: ${err.message}`, 'error')
    }
  })

  document.querySelectorAll('.project-create-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.project-create-tab').forEach((b) => b.classList.remove('active'))
      tabBtn.classList.add('active')

      const isProgram = tabBtn.dataset.createTab === 'program'
      document.getElementById('create-program-panel').classList.toggle('hidden', !isProgram)
      document.getElementById('create-project-panel').classList.toggle('hidden', isProgram)
    })
  })

  document.getElementById('createProgramBtn').addEventListener('click', async () => {
    try {
      await createProgram()
    } catch (err) {
      showCreateStatus(`Could not create program: ${err.message}`, 'error')
    }
  })

  document.getElementById('createProjectBtn').addEventListener('click', async () => {
    try {
      await createProject()
    } catch (err) {
      showCreateStatus(`Could not create project: ${err.message}`, 'error')
    }
  })

  // ── Feed filters ───────────────────────────────────────────────────────────
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      feedFilter = btn.dataset.filter
      renderFeed(feedItems)
    })
  })
}

document.addEventListener('DOMContentLoaded', init)
