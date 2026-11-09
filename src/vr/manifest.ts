import { defineDomain } from '../core/domain.ts'
import { homePath } from '../core/paths.ts'
import { absentView, digestOf, removeFile } from '../core/sessions.ts'
import { vrCommands } from './commands.ts'
import { clearSession, loadSession } from './auth.ts'

const VRCHAT = { domain: 'vrchat', label: 'VRChat', howToLogin: 'astra vr login --username <账号> --password <密码>' }

export const domain = defineDomain({
  name: 'vr',
  commands: vrCommands,
  sessions: [
    {
      domain: 'vrchat',
      view() {
        const session = loadSession()
        if (!session) return absentView(VRCHAT, homePath('vr-session.json'))
        return {
          ...VRCHAT,
          state: 'logged_in',
          account: session.displayName ?? session.userId ?? null,
          digest: digestOf(session.cookie),
          savedAt: session.savedAt,
          fileIssue: null,
        }
      },
      clear() {
        removeFile(homePath('vr-session.json'))
        // 两步验证中间态也顺手清掉，否则下次登录可能读到过期的待确认
        clearSession()
      },
    },
  ],
})
