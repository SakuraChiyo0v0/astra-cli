/**
 * `steam-user` 没自带类型（包里没有 .d.ts），这里只声明我们真正用到的部分。
 *
 * 只写用得到的：logOn(refreshToken) → loggedOn → setPersona / gamesPlayed，
 * 外加 error / disconnected 两个事件。没声明的成员一律不可用，避免误用不存在的 API。
 */
declare module 'steam-user' {
  import { EventEmitter } from 'node:events'

  interface LogOnOptions {
    refreshToken?: string
    accountName?: string
    password?: string
    steamGuardCode?: string
  }

  interface SteamUserOptions {
    /** 掉线自动重连（挂时长必须开）。 */
    autoRelogin?: boolean
    /** 走 HTTP 代理，如 http://mihomo:7890。留空直连 CM。 */
    httpProxy?: string
  }

  interface EPersonaStateMap {
    Offline: 0
    Online: 1
    Busy: 2
    Away: 3
    Snooze: 4
    LookingToTrade: 5
    LookingToPlay: 6
    Invisible: 7
  }

  class SteamUser extends EventEmitter {
    static EPersonaState: EPersonaStateMap
    constructor(options?: SteamUserOptions)
    /** 登录成功后才有；格式上是 SteamID 对象，`getSteamID64()` 拿字符串。 */
    steamID: { getSteamID64(): string } | null
    logOn(options: LogOnOptions): void
    logOff(): void
    setPersona(state?: number, name?: string): void
    gamesPlayed(games: (number | string)[], force?: boolean): void
    on(event: 'loggedOn', listener: (details: { client_supplied_steamid: string }, parental: boolean) => void): this
    on(event: 'error', listener: (err: Error & { eresult?: number }) => void): this
    on(event: 'disconnected', listener: (eresult: number, msg?: string) => void): this
  }

  export default SteamUser
  export type { LogOnOptions, SteamUserOptions }
}
