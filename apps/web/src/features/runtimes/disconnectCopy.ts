// The confirm text for a full runtime Disconnect, built from the plan the server
// reports with the runtime's status (`disconnectPlan`), so it names exactly the
// saved keys that are deleted and the ones that stay because another runtime
// also uses them.

import type { RuntimeDisconnectPlan } from '@clawboo/control-client'

import { nativeConnectProvider, nativeProviderForEnvVar } from '@/lib/nativeProviders'

/** A provider's display name for its vault env var, else the env var itself. */
function providerName(envVar: string): string {
  const id = nativeProviderForEnvVar(envVar)
  return (id && nativeConnectProvider(id)?.name) || envVar
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function runtimeDisconnectMessage(
  name: string,
  plan: RuntimeDisconnectPlan | null | undefined,
  opts: { ollama?: boolean } = {},
): string {
  if (!plan) {
    return `This deletes the saved keys only ${name} uses and keeps any key another runtime also uses. ${name} stops using its keys until you connect it again.`
  }
  const parts: string[] = []
  if (plan.removes.length > 0) {
    const names = joinNames(plan.removes.map(providerName))
    parts.push(`This deletes your saved ${names} ${plan.removes.length === 1 ? 'key' : 'keys'}.`)
  }
  if (opts.ollama) parts.push('It turns off local Ollama.')
  if (plan.keeps.length === 1) {
    const [kept] = plan.keeps
    parts.push(
      `Your ${providerName(kept!.envVar)} key stays saved, because ${joinNames(kept!.sharedWith)} ${kept!.sharedWith.length === 1 ? 'uses' : 'use'} it too.`,
    )
  } else if (plan.keeps.length > 1) {
    const each = plan.keeps.map((k) => `${providerName(k.envVar)} (${joinNames(k.sharedWith)})`)
    parts.push(`These keys stay saved, because other runtimes use them: ${each.join(', ')}.`)
  }
  parts.push(
    plan.removes.length + plan.keeps.length > 0
      ? `${name} stops using them until you connect it again.`
      : `No key is saved for ${name}, so nothing is deleted. It stops using any key from your environment until you connect it again.`,
  )
  if (plan.keeps.length > 0) {
    parts.push(
      `To delete ${plan.keeps.length === 1 ? 'that key' : 'a kept key'}, disconnect it under Settings > Providers.`,
    )
  }
  return parts.join(' ')
}
