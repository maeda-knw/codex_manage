import type { ConversationRuntimeSettings } from '../../conversation/conversationSession';

export function runtimeSettingsSummary(runtime: ConversationRuntimeSettings | undefined): string {
  if (!runtime || runtime.status === 'loading') return 'Loading settings…';
  if (runtime.status === 'unavailable') return 'Unavailable';
  const model = runtimeOptionLabel(runtime.models, runtime.model) ?? 'Current model unavailable';
  const effort = runtime.effort
    ? runtimeOptionLabel(runtime.efforts, runtime.effort) ?? `${runtime.effort} (current, unlisted)`
    : defaultRuntimeLabel('Default', runtime.defaultEffort, runtime.efforts);
  const parts = [model, effort];
  if (runtime.serviceTiers.length > 0 || runtime.serviceTier || runtime.defaultServiceTier) {
    parts.push(runtime.serviceTier
      ? runtimeOptionLabel(runtime.serviceTiers, runtime.serviceTier) ?? `${runtime.serviceTier} (current, unlisted)`
      : defaultRuntimeLabel('Default speed', runtime.defaultServiceTier, runtime.serviceTiers));
  }
  return parts.join(' · ');
}

export function defaultRuntimeLabel(
  fallback: string,
  defaultValue: string | null | undefined,
  options: readonly { readonly value: string; readonly label: string }[]
): string {
  if (!defaultValue) return options.length > 0 ? fallback : 'Unavailable';
  return `${fallback} (${runtimeOptionLabel(options, defaultValue) ?? defaultValue})`;
}

function runtimeOptionLabel(
  options: readonly { readonly value: string; readonly label: string }[],
  value: string | null | undefined
): string | undefined {
  return value ? options.find((option) => option.value === value)?.label : undefined;
}
