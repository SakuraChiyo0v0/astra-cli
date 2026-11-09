import { defineDomain, type DoctorContext } from '../core/domain.ts'
import { getConfig, mediaRoot, musicRoot } from '../core/config.ts'
import { homePath } from '../core/paths.ts'
import { absentView, removeFile } from '../core/sessions.ts'
import { renderTemplate } from '../core/template.ts'
import { biliCommands } from './commands.ts'
import { biliSessionDigest, loadBiliSession } from './auth.ts'
import { targetPathFor } from './download.ts'

async function doctor({ add, checkWritable, ensureExists, watchDisk }: DoctorContext): Promise<void> {
  const video = mediaRoot()
  try {
    ensureExists(video)
    const write = checkWritable(video)
    add({ name: 'video_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查视频目录的属主与权限' }) })
  } catch (err) {
    add({ name: 'video_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }
  watchDisk('video_disk', video)

  // 生效路径：把模板**展开成示例路径**。
  //
  // 为什么需要：`bili.template` / `bili.audio-template` / `bili.audio-dir` 三个配置
  // 决定文件落哪儿，但改完只能真下一个文件才知道对不对。实测踩过一次：
  // `--to bili` 用错了模板、落成 `<标题>/01.mp3`，看 doctor 完全发现不了。
  //
  // 示例用一个固定的假数据，不依赖网络也不依赖曲库 —— 目的是让「配置 → 落点」一眼可见。
  {
    const sampleInfo = {
      bvid: 'BV1xx411c7mD',
      // 带《》：音频模板的 `{title}` 走 `songTitleOf`，取《》里的歌名。
      // 写「示例视频标题」的话它会退回分 P 名，展开出「示例分P」——
      // 那会让人以为音频模板里也有 `{part}`（清单 P3#4f）
      title: '示例视频标题《示例歌名》',
      owner: { mid: 0, name: '示例UP主' },
      pubdate: 0,
      // 两个分 P：视频模板里的 `{part}` 才会展开出内容（单 P 时它是空的），
      // 示例才看得出「分 P 名会进文件名」这件事
      pages: [
        { cid: 1, page: 1, part: '示例分P', duration: 0 },
        { cid: 2, page: 2, part: '第二P', duration: 0 },
      ],
    } as never
    const samplePage = { cid: 1, page: 1, part: '示例分P', duration: 0 }
    const audioDir = getConfig('bili.audio-dir')
    const expand = (kind: 'video' | 'audio'): string => {
      try {
        const { root, template, vars } = targetPathFor(sampleInfo, samplePage, kind === 'audio' ? { audioOnly: true } : {}, 1080)
        return `${root}/${renderTemplate(template, vars)}`
      } catch (err) {
        return `（模板展开失败：${(err as Error).message.slice(0, 80)}）`
      }
    }
    add({
      name: 'bili.paths',
      kind: 'domain',
      ok: true,
      detail: [
        `bili.dir            ${video}`,
        `bili.audio-dir      ${audioDir ? audioDir : `跟随 music.dir（${musicRoot()}）`}`,
        `  video-template    → ${expand('video')}`,
        `  audio-template    → ${expand('audio')}`,
      ].join('\n'),
    })
  }

  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV17x411w7KC', {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const body = (await response.json()) as { code?: number }
    add({ name: 'bili_api', kind: 'domain', ok: body.code === 0, detail: `B 站接口 code=${String(body.code)}` })
  } catch (err) {
    add({ name: 'bili_api', kind: 'domain', ok: false, detail: (err as Error).message.slice(0, 120) })
  }

  const session = loadBiliSession()
  add({
    name: 'bili_login',
    kind: 'optional',
    ok: session !== null,
    detail: session ? `已登录（${session.nickname ?? session.uid ?? '会话存在'}${session.vip ? '，大会员' : ''}）` : '未登录',
    ...(session ? {} : { hint: '登录后才能拿到 1080P 以上画质（`astra bili login start`）' }),
  })
}

const BILI = { domain: 'bili', label: 'B 站', howToLogin: 'astra bili login start' }

export const domain = defineDomain({
  name: 'bili',
  commands: biliCommands,
  doctor,
  sessions: [
    {
      domain: 'bili',
      view() {
        const session = loadBiliSession()
        if (!session) return absentView(BILI, homePath('bili-session.json'))
        const who = session.nickname ?? session.uid ?? null
        return {
          ...BILI,
          state: 'logged_in',
          account: who ? `${who}${session.vip ? '（大会员）' : ''}` : null,
          digest: biliSessionDigest(session),
          savedAt: session.savedAt,
          fileIssue: null,
        }
      },
      clear: () => removeFile(homePath('bili-session.json')),
    },
  ],
})
