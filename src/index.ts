/**
 * @dsh-external/dsh-sound-alerts — 声音提示插件（node half）。
 *
 * 纯 UI 插件：空 apply 使该行出现在 host cordis.yml / Loader 中（与
 * @deepseek-ai/dsh-client-ui-goal 等表层插件同款约定）；浏览器端行为经
 * exports["./client"] 与 package.json 的 dsh.client 声明装载，本 half 不持有
 * 任何宿主逻辑。
 */
export function apply(): void {
  /* no host-side behavior — see the client half */
}
