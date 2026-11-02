/**
 * Browser half of the plugin: the library entry in the session header
 * utilities, the management panel as a tab of the right sidebar, and the
 * settings page that configures the embedding endpoint and the per-workspace
 * answer scope.
 * @module cyberself/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { LibraryTabBody, LibraryToggle } from './panel.tsx'
import { LibrarySettings } from './settings.tsx'
import { setWorkspaceSource } from './workspaces.ts'
import { installStyles } from './styles.ts'

/** Module identity used by the client module system. */
export const name = 'cyberself'

/** Client services this plugin needs before it applies. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'workspaces']

/** Registry identity of the library tab type, which is also the seat key of its body. */
const TAB_ID = 'cyberself'

/** Kind the library tab is opened by. */
const TAB_KIND = 'cyberself.library'

/** Props every conversation seat is given. */
interface SeatProps {
  sessionId: SessionId
}

/**
 * Register the conversation seats, the sidebar tab and the settings page.
 * @param ctx - client plugin scope.
 */
export function apply(ctx: Context): void {
  installStyles()
  setWorkspaceSource(ctx.workspaces.list)

  const openPanel = (): void => {
    ctx.sidebarRight.openTab(TAB_KIND)
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => '资料库',
    guide: [
      {
        order: 60,
        title: () => '资料库',
        description: () => '导入资料、查看分块、检索',
      },
    ],
  }))

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    function LibraryTabSeat(props: SeatProps) {
      return <LibraryTabBody sessionId={props.sessionId} />
    },
  )))

  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'cyberself-toggle', order: 30 },
    function LibraryToggleSeat() {
      return <LibraryToggle openPanel={openPanel} />
    },
  )))

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'cyberself', order: 55, label: '资料库' },
    LibrarySettings,
  )))
}
