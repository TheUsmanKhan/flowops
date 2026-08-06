'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Plug,
  Truck,
  ShoppingCart,
  Loader2,
  Plus,
  CheckCircle2,
  AlertCircle,
  Clock,
  Copy,
  Star,
  Settings2,
  Power,
  Zap,
  Info,
  RefreshCw,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/components/orders/_shared'
import { PickupAddressesSection } from '@/components/couriers/pickup-addresses-section'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ConfigField {
  key: string
  label: string
  type: 'text' | 'password'
  required: boolean
}

interface Provider {
  id: string
  providerKey: string
  providerName: string
  category: string
  logoUrl: string | null
  authType: string
  supportsWebhook: boolean
  configSchema: string
  capabilities: string
}

interface Integration {
  id: string
  connectionName: string
  isActive: boolean
  isDefault: boolean
  connectionStatus: string
  lastSyncAt: string | null
  lastError: string | null
  webhookEndpointId: string | null
  webhookUrl: string | null
  createdAt: string
  provider: {
    id: string
    providerKey: string
    providerName: string
    category: string
    logoUrl: string | null
    authType: string
    supportsWebhook: boolean
    configSchema: string
  }
}

interface ApiResponse {
  providers: Provider[]
  integrations: Integration[]
}

// ──────────────────────────────────────────────────────────────
// Status badge helper
// ──────────────────────────────────────────────────────────────

/**
 * Status badge — checks `isActive` FIRST. A disconnected integration
 * (isActive=false) always shows a muted "Disconnected" badge regardless
 * of its connectionStatus field. This fixes the bug where disconnected
 * integrations still showed a green "Connected" badge.
 */
function StatusBadge({ status, isActive }: { status: string; isActive: boolean }) {
  // Disconnected integrations always show "Disconnected" — no matter what
  // the connectionStatus column says.
  if (!isActive) {
    return (
      <Badge variant="outline" className="text-[10px] bg-slate-100 text-slate-500 border-slate-300">
        <Power className="h-2.5 w-2.5 mr-0.5" /> Disconnected
      </Badge>
    )
  }
  const config: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
    connected: { label: 'Connected', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
    pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock },
    error: { label: 'Error', className: 'bg-rose-50 text-rose-700 border-rose-200', icon: AlertCircle },
    expired: { label: 'Expired', className: 'bg-slate-50 text-slate-700 border-slate-200', icon: Clock },
  }
  const c = config[status] ?? config.pending
  const Icon = c.icon
  return (
    <Badge variant="outline" className={cn('text-[10px]', c.className)}>
      <Icon className="h-2.5 w-2.5 mr-0.5" /> {c.label}
    </Badge>
  )
}

// ──────────────────────────────────────────────────────────────
// Main view
// ──────────────────────────────────────────────────────────────

export function IntegrationsView() {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const [connectProvider, setConnectProvider] = useState<Provider | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState<Integration | null>(null)

  const query = useQuery<ApiResponse>({
    queryKey: ['integrations'],
    queryFn: () => api.get<ApiResponse>('/api/integrations'),
    staleTime: 15_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['integrations'] })
    // Also invalidate order-settings (default courier may have been cleared)
    queryClient.invalidateQueries({ queryKey: ['order-settings'] })
  }

  // Mutations
  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; error?: string; status?: string }>(`/api/integrations/${id}/test`),
    onSuccess: (data: { ok: boolean; error?: string; status?: string }) => {
      if (data.ok) toast.success('Connection test succeeded.')
      else toast.error(data.error || 'Connection test failed.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/integrations/${id}/disconnect`),
    onSuccess: () => { toast.success('Integration disconnected. Credentials wiped.'); invalidate() },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/integrations/${id}/set-default`),
    onSuccess: () => { toast.success('Set as default.'); invalidate() },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const syncCitiesMutation = useMutation({
    mutationFn: (providerKey: string) =>
      api.post<{ success: boolean; message?: string; providerKey?: string }>(
        '/api/couriers/sync-cities',
        { providerKey },
      ),
    onSuccess: (data) => {
      // The sync runs in the background (PostEx API can take 30-60s).
      // Show a "started" toast now, and refetch the cities after a delay.
      toast.success('City sync started in the background. This may take 30-60 seconds.')
      // Refetch the integrations query after 30s to pick up the updated
      // lastSyncAt timestamp + any new cities.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['integrations'] })
        queryClient.invalidateQueries({ queryKey: ['courier-cities'] })
        toast.success('City sync complete — cities list refreshed.')
      }, 35_000)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Integrations" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Integrations" />
        <Card><CardContent className="p-10 text-center">
          <p className="text-sm text-muted-foreground mb-4">{getErrorMessage(query.error)}</p>
          <Button variant="outline" onClick={() => query.refetch()}>Try again</Button>
        </CardContent></Card>
      </div>
    )
  }

  const providers = query.data?.providers ?? []
  const integrations = query.data?.integrations ?? []

  const courierProviders = providers.filter((p) => p.category === 'courier')
  const ecommerceProviders = providers.filter((p) => p.category === 'ecommerce')
  const courierIntegrations = integrations.filter((i) => i.provider.category === 'courier')
  const ecommerceIntegrations = integrations.filter((i) => i.provider.category === 'ecommerce')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect courier and ecommerce platforms. Credentials are encrypted at rest."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'integration-logs' })}>
            View Logs
          </Button>
        }
      />

      {/* Framework-only notice */}
      <div className="rounded-md border border-sky-200 bg-sky-50 p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-sky-600 shrink-0 mt-0.5" />
        <div className="text-xs text-sky-800">
          <strong>Integration framework is active.</strong> Provider adapters are currently in
          stub mode — you can connect and configure providers now, but actual API calls (booking
          shipments, receiving orders) will be available once each provider&apos;s adapter is
          fully implemented. Connection testing will also show &quot;not yet implemented&quot; for
          stub providers.
        </div>
      </div>

      <Tabs defaultValue="courier">
        <TabsList>
          <TabsTrigger value="courier" className="gap-1.5">
            <Truck className="h-3.5 w-3.5" /> Couriers
          </TabsTrigger>
          <TabsTrigger value="ecommerce" className="gap-1.5">
            <ShoppingCart className="h-3.5 w-3.5" /> Ecommerce
          </TabsTrigger>
        </TabsList>

        <TabsContent value="courier" className="space-y-6 mt-4">
          <IntegrationsSection
            integrations={courierIntegrations}
            availableProviders={courierProviders.filter(
              (p) => !courierIntegrations.some((i) => i.provider.id === p.id && i.isActive)
            )}
            onConnect={setConnectProvider}
            onTest={(id) => testMutation.mutate(id)}
            onDisconnect={(i) => setConfirmDisconnect(i)}
            onSetDefault={(id) => setDefaultMutation.mutate(id)}
            onSyncCities={(providerKey) => syncCitiesMutation.mutate(providerKey)}
            syncingCities={syncCitiesMutation.isPending}
            testing={testMutation.isPending}
          />
        </TabsContent>

        <TabsContent value="ecommerce" className="space-y-6 mt-4">
          <IntegrationsSection
            integrations={ecommerceIntegrations}
            availableProviders={ecommerceProviders.filter(
              (p) => !ecommerceIntegrations.some((i) => i.provider.id === p.id && i.isActive)
            )}
            onConnect={setConnectProvider}
            onTest={(id) => testMutation.mutate(id)}
            onDisconnect={(i) => setConfirmDisconnect(i)}
            onSetDefault={(id) => setDefaultMutation.mutate(id)}
            testing={testMutation.isPending}
          />
        </TabsContent>
      </Tabs>

      {connectProvider && (
        <ConnectDialog
          provider={connectProvider}
          open={!!connectProvider}
          onOpenChange={(v) => !v && setConnectProvider(null)}
          onConnected={() => { setConnectProvider(null); invalidate() }}
        />
      )}

      {/* Disconnect confirmation dialog */}
      <AlertDialog open={!!confirmDisconnect} onOpenChange={(v) => !v && setConfirmDisconnect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {confirmDisconnect?.provider.providerName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the integration, wipe all stored credentials, and clear it
              as the default courier if it was set. You can reconnect later with new credentials.
              Any orders currently in the Booking Workbench will need to be booked manually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (confirmDisconnect) {
                  disconnectMutation.mutate(confirmDisconnect.id)
                  setConfirmDisconnect(null)
                }
              }}
            >
              <Power className="h-3.5 w-3.5" /> Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Section: connected + available
// ──────────────────────────────────────────────────────────────

function IntegrationsSection({
  integrations,
  availableProviders,
  onConnect,
  onTest,
  onDisconnect,
  onSetDefault,
  onSyncCities,
  syncingCities,
  testing,
}: {
  integrations: Integration[]
  availableProviders: Provider[]
  onConnect: (p: Provider) => void
  onTest: (id: string) => void
  onDisconnect: (i: Integration) => void
  onSetDefault: (id: string) => void
  onSyncCities?: (providerKey: string) => void
  syncingCities?: boolean
  testing: boolean
}) {
  // Only show ACTIVE integrations in the "Connected" section.
  // Disconnected integrations are hidden — the provider reappears in
  // "Available to Connect" so the user can connect fresh.
  const activeIntegrations = integrations.filter((i) => i.isActive)

  return (
    <>
      {/* Connected */}
      {activeIntegrations.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Connected</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {activeIntegrations.map((i) => (
              <Card key={i.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{i.provider.providerName}</p>
                        {i.isDefault && (
                          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px]">
                            <Star className="h-2.5 w-2.5 mr-0.5 fill-current" /> Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{i.connectionName}</p>
                    </div>
                    <StatusBadge status={i.connectionStatus} isActive={i.isActive} />
                  </div>

                  {i.lastError && (
                    <p className="text-xs text-rose-600 bg-rose-50 rounded p-2">{i.lastError}</p>
                  )}

                  {i.webhookUrl && (
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Webhook URL</p>
                      <div className="flex items-center gap-1">
                        <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded truncate flex-1">{i.webhookUrl}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5"
                          onClick={() => {
                            navigator.clipboard.writeText(i.webhookUrl!)
                            toast.success('Webhook URL copied.')
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-1 flex-wrap pt-1">
                    {!i.isDefault && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onSetDefault(i.id)}>
                        <Star className="h-3 w-3" /> Set Default
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onTest(i.id)} disabled={testing}>
                      <Zap className="h-3 w-3" /> Test
                    </Button>
                    {onSyncCities && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => onSyncCities(i.provider.providerKey)}
                        disabled={syncingCities}
                        title="Sync operational cities from courier API"
                      >
                        {syncingCities ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        {' '}Sync Cities
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                      onClick={() => onDisconnect(i)}
                    >
                      <Power className="h-3 w-3" /> Disconnect
                    </Button>
                  </div>

                  {/* Pickup & Return Addresses section — only for courier integrations */}
                  {i.provider.category === 'courier' && (
                    <PickupAddressesSection
                      companyIntegrationId={i.id}
                      providerKey={i.provider.providerKey}
                    />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Available to connect */}
      {availableProviders.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Available to Connect</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {availableProviders.map((p) => (
              <Card key={p.id}>
                <CardContent className="p-4 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{p.providerName}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.supportsWebhook ? 'Supports webhooks' : 'No webhooks'} · {p.authType}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => onConnect(p)}>
                    <Plus className="h-3.5 w-3.5" /> Connect
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {activeIntegrations.length === 0 && availableProviders.length === 0 && (
        <Card><CardContent className="p-10 text-center">
          <Plug className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">No providers available in this category.</p>
        </CardContent></Card>
      )}
    </>
  )
}

// ──────────────────────────────────────────────────────────────
// Connect dialog (dynamic form from config_schema)
// ──────────────────────────────────────────────────────────────

function ConnectDialog({
  provider,
  open,
  onOpenChange,
  onConnected,
}: {
  provider: Provider
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
}) {
  const [connectionName, setConnectionName] = useState('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [createdWebhookUrl, setCreatedWebhookUrl] = useState<string | null>(null)

  // Parse config_schema dynamically — this works for ANY provider
  let fields: ConfigField[] = []
  try {
    fields = JSON.parse(provider.configSchema)
  } catch {
    fields = []
  }

  const connectMutation = useMutation({
    mutationFn: () =>
      api.post<{ companyIntegrationId: string; webhookUrl?: string }>('/api/integrations', {
        provider_id: provider.id,
        connection_name: connectionName.trim() || `${provider.providerName} Connection`,
        credentials,
      }),
    onSuccess: (data) => {
      toast.success('Integration connected.')
      if (data.webhookUrl) setCreatedWebhookUrl(data.webhookUrl)
      else onConnected()
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to connect')
    },
  })

  const canSubmit = fields.every((f) => !f.required || (credentials[f.key] && credentials[f.key].trim()))

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Connect {provider.providerName}
          </DialogTitle>
          <DialogDescription>
            Enter your {provider.providerName} credentials. They will be encrypted before storage.
          </DialogDescription>
        </DialogHeader>

        {createdWebhookUrl ? (
          <div className="space-y-4 py-2">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 space-y-2">
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                <p className="text-sm font-medium">Connected successfully!</p>
              </div>
              {provider.supportsWebhook && (
                <div className="space-y-1">
                  <p className="text-xs text-emerald-700">
                    Add this URL to your {provider.providerName}&apos;s webhook settings to receive
                    real-time updates:
                  </p>
                  <div className="flex items-center gap-1">
                    <code className="text-[10px] bg-white border px-1.5 py-0.5 rounded truncate flex-1">
                      {createdWebhookUrl}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5"
                      onClick={() => {
                        navigator.clipboard.writeText(createdWebhookUrl)
                        toast.success('Copied.')
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <Button className="w-full" onClick={onConnected}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Connection name */}
            <div className="space-y-1.5">
              <Label className="text-xs">Connection Name</Label>
              <Input
                placeholder={`e.g. ${provider.providerName} - Main Account`}
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground">
                A label to identify this connection if you have multiple {provider.providerName} accounts.
              </p>
            </div>

            {/* Dynamic credential fields from config_schema */}
            {fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label className="text-xs">
                  {field.label}
                  {field.required && <span className="text-rose-600 ml-0.5">*</span>}
                </Label>
                <Input
                  type={field.type === 'password' ? 'password' : 'text'}
                  placeholder={field.type === 'password' ? '••••••••' : `Enter ${field.label}`}
                  value={credentials[field.key] ?? ''}
                  onChange={(e) => setCredentials((p) => ({ ...p, [field.key]: e.target.value }))}
                />
              </div>
            ))}

            {/* Framework note */}
            <div className="rounded-md bg-amber-50 border border-amber-200 p-2.5 text-[10px] text-amber-800">
              Note: This provider&apos;s adapter is currently a stub. Credentials will be saved
              securely, but actual API calls and connection testing will be available once the
              adapter is fully implemented.
            </div>
          </div>
        )}

        {!createdWebhookUrl && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              disabled={!canSubmit || connectMutation.isPending}
              onClick={() => connectMutation.mutate()}
            >
              {connectMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
              ) : (
                <>Connect</>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
