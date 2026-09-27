import { type ContentScriptApi, installPageRelay, type PageWindow } from './page-relay.js'

declare const chrome: ContentScriptApi
declare const window: PageWindow

installPageRelay(window, chrome)
