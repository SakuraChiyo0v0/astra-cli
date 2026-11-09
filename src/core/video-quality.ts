/**
 * B 站画质名表。B 站用 qn 编号，DASH 下 `dash.video[].id` 也是这一套。
 * 未登录封顶 360P（实测），登录后才可能拿到 1080P / 4K / HDR。
 *
 * 放在 core：`bili.quality` 配置键的校验要用它，而 core/config.ts 不能 import bili。
 * bili/sign.ts 原样再导出，领域内的用法不变。
 */
export const QUALITY_NAMES: Record<number, string> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}
