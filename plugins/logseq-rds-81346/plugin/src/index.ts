import '@logseq/libs'

declare const logseq: any

const PAGE_NAME = 'RDS/81346 #Project'
const PROGRAM_NAME = 'RDS'

const SEED_BLOCKS = [
  'project-id:: RDS-81346',
  '#request Define implementation scope for RDS 81346',
  '#event Kickoff created from RDS 81346 plugin',
  '#news Progress updates for RDS 81346 go here',
  '## Checklist',
  '- TODO Confirm requirements',
  '- TODO Build first milestone',
]

async function ensurePageExists(): Promise<boolean> {
  const existing = await logseq.Editor.getPage(PAGE_NAME)

  await logseq.Editor.createPage(
    PAGE_NAME,
    {
      program: PROGRAM_NAME,
      project_id: 'RDS-81346',
    },
    { redirect: false, createFirstBlock: false }
  )

  return Boolean(existing)
}

async function seedIfEmpty(): Promise<void> {
  const tree = await logseq.Editor.getPageBlocksTree(PAGE_NAME)
  if (Array.isArray(tree) && tree.length > 0) return

  for (const line of SEED_BLOCKS) {
    await logseq.Editor.appendBlockInPage(PAGE_NAME, line)
  }
}

async function createOrOpenRds81346(): Promise<void> {
  const alreadyExists = await ensurePageExists()
  await seedIfEmpty()
  await logseq.App.pushState('page', { name: PAGE_NAME })

  if (alreadyExists) {
    logseq.UI.showMsg('Opened existing RDS 81346 project', 'success')
  } else {
    logseq.UI.showMsg('Created RDS 81346 project page', 'success')
  }
}

function registerCommands(): void {
  logseq.Editor.registerSlashCommand('RDS 81346: Create or Open', async () => {
    await createOrOpenRds81346()
  })

  logseq.App.registerCommandPalette(
    {
      key: 'rds-81346-create-or-open',
      label: 'RDS 81346: Create or Open Project',
    },
    async () => {
      await createOrOpenRds81346()
    }
  )

  logseq.App.registerUIItem('toolbar', {
    key: 'rds-81346-open',
    template: '<a class="button" data-on-click="openRds81346" title="Open RDS 81346">RDS81346</a>',
  })

  logseq.provideModel({
    async openRds81346() {
      await createOrOpenRds81346()
    },
  })
}

async function main(): Promise<void> {
  registerCommands()
  console.log('[rds-81346] Plugin loaded')
}

logseq.ready(main).catch((error: unknown) => {
  console.error('[rds-81346] Failed to load plugin:', error)
})
