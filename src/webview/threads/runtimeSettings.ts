import type { ConversationRuntimeSettings } from '../../conversation/conversationSession';

export function runtimeSettingsSummary(runtime: ConversationRuntimeSettings | undefined): string {
  if (!runtime || runtime.status === 'loading') return 'Loading settings…';
  if (runtime.status === 'unavailable') return 'Unavailable';
  const model = compactModelLabel(
    runtimeOptionLabel(runtime.models, runtime.model) ?? runtime.model ?? 'Model unavailable'
  );
  const effort = effectiveRuntimeLabel(
    runtime.efforts,
    runtime.effort,
    runtime.defaultEffort
  );
  const parts = [model];
  if (effort) parts.push(effort);
  if (isFastRuntime(runtime)) parts.push('Fast');
  parts.push(runtimePermissionLabel(runtime.sandbox));
  return parts.join(' · ');
}

export function compactModelLabel(label: string): string {
  const version = label.match(/\bgpt[-_\s]*([0-9]+(?:\.[0-9]+)*)/iu)?.[1];
  if (!version) return stripRuntimeMetadata(label);
  const variant = label.match(/(?:^|[-_\s])(sol|terra|luna)(?=$|[-_\s(])/iu)?.[1];
  return variant
    ? `${version} ${variant[0]?.toUpperCase() ?? ''}${variant.slice(1).toLowerCase()}`
    : version;
}

export function runtimePermissionLabel(
  sandbox: ConversationRuntimeSettings['sandbox']
): string {
  switch (sandbox) {
    case 'read-only':
      return 'Read only';
    case 'danger-full-access':
      return 'Full access';
    default:
      return 'Workspace';
  }
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

function effectiveRuntimeLabel(
  options: readonly { readonly value: string; readonly label: string }[],
  selectedValue: string | null | undefined,
  defaultValue: string | null | undefined
): string | undefined {
  const value = selectedValue ?? defaultValue;
  if (!value) return undefined;
  return stripRuntimeMetadata(runtimeOptionLabel(options, value) ?? runtimeValueLabel(value));
}

function isFastRuntime(runtime: ConversationRuntimeSettings): boolean {
  const value = runtime.serviceTier ?? runtime.defaultServiceTier;
  if (!value) return false;
  const label = stripRuntimeMetadata(runtimeOptionLabel(runtime.serviceTiers, value) ?? value);
  return value.toLowerCase() === 'fast' || value.toLowerCase() === 'priority' || label.toLowerCase() === 'fast';
}

function stripRuntimeMetadata(label: string): string {
  return label.replace(/\s*\(current, unlisted\)\s*$/iu, '').trim();
}

function runtimeValueLabel(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}
