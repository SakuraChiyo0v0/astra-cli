/**
 * 领域登记表：加 / 删一个领域只改这里一行（外加它自己的目录）。
 *
 * 顺序就是 `astra help` 里的顺序。目前还是静态 import；
 * 下一步（P2）换成 `() => import(...)` 按命令首词懒加载。
 */
import type { DomainModule } from './core/domain.ts'
import { domain as music } from './music/manifest.ts'
import { domain as bili } from './bili/manifest.ts'
import { domain as media } from './media/manifest.ts'
import { domain as steam } from './steam/manifest.ts'
import { domain as vr } from './vr/manifest.ts'
import { domain as model } from './model/manifest.ts'
import { domain as quark } from './quark/manifest.ts'
import { domain as cloud } from './cloud/manifest.ts'
import { domain as pixiv } from './pixiv/manifest.ts'
import { domain as jm } from './jm/manifest.ts'
import { domain as douyin } from './douyin/manifest.ts'
import { domain as lol } from './lol/manifest.ts'
import { domain as heybox } from './heybox/manifest.ts'
import { domain as llm } from './llm/manifest.ts'
import { domain as device } from './device/manifest.ts'
import { domain as x } from './x/manifest.ts'
import { domain as auth } from './auth/manifest.ts'
import { domain as schedule } from './schedule/manifest.ts'
import { domain as novel } from './novel/manifest.ts'
import { domain as comic } from './comic/manifest.ts'
import { domain as archive } from './archive/manifest.ts'

export const DOMAINS: DomainModule[] = [
  music, bili, media, steam, vr, model, quark, cloud, pixiv, jm, douyin, lol, heybox, llm, device, x, auth, schedule, novel, comic, archive,
]
