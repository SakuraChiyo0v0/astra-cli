import { defineDomain, type DoctorContext } from '../core/domain.ts'
import { musicRoot } from '../core/config.ts'
import { homePath } from '../core/paths.ts'
import { absentView, digestOf, removeFile } from '../core/sessions.ts'
import { musicCommands } from './commands.ts'
import { listSources } from './lx/store.ts'
import { loadSession } from './auth.ts'

async function doctor({ add, checkWritable, ensureExists, watchDisk }: DoctorContext): Promise<void> {
  const music = musicRoot()
  try {
    ensureExists(music)
    const write = checkWritable(music)
    add({ name: 'music_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查音乐目录的属主与权限（WebDAV 上传后常见 000）' }) })
  } catch (err) {
    add({ name: 'music_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }
  watchDisk('music_disk', music)

  const sources = listSources()
  const enabled = sources.filter((s) => s.enabled)
  add({
    name: 'lx_sources',
    kind: 'domain',
    ok: enabled.length > 0,
    detail: sources.length === 0 ? '未导入音源' : enabled.map((s) => s.id).join(', ') || '全部停用',
    ...(enabled.length > 0 ? {} : { hint: '`astra music source add <文件>` 导入洛雪音源；登录官方账号也能下载' }),
  })

  try {
    const response = await fetch('https://music.163.com/api/v3/song/detail?c=' + encodeURIComponent('[{"id":1472480890}]'), {
      headers: { Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8000),
    })
    add({ name: 'netease', kind: 'domain', ok: response.ok, detail: `网易云接口 HTTP ${response.status}` })
  } catch (err) {
    add({ name: 'netease', kind: 'domain', ok: false, detail: (err as Error).message.slice(0, 120), hint: '检查网络或代理' })
  }

  const session = loadSession()
  add({
    name: 'netease_login',
    kind: 'optional',
    ok: session !== null,
    detail: session ? `已登录（${session.nickname ?? session.userId ?? '会话存在'}）` : '未登录',
    ...(session ? {} : { hint: '登录后能用官方通道取更高音质、看私人歌单（`astra music login start`）' }),
  })
}

const NETEASE = { domain: 'netease', label: '网易云', howToLogin: 'astra music login start' }

export const domain = defineDomain({
  name: 'music',
  commands: musicCommands,
  doctor,
  sessions: [
    {
      domain: 'netease',
      view() {
        const session = loadSession()
        if (!session) return absentView(NETEASE, homePath('netease-session.json'))
        return {
          ...NETEASE,
          state: 'logged_in',
          account: session.nickname ?? session.userId ?? null,
          digest: digestOf(session.cookie),
          savedAt: session.savedAt,
          fileIssue: null,
        }
      },
      clear: () => removeFile(homePath('netease-session.json')),
    },
  ],
})
