import { delay, SynchronizationState } from '@catalyst/commons'
import { DeploymentWithAuditInfo, ServerAddress, Timestamp } from 'dcl-catalyst-commons'
import log4js from 'log4js'
import ms from 'ms'
import { clearTimeout, setTimeout } from 'timers'
import { metricsComponent } from '../../metrics'
import { SystemPropertiesManager, SystemProperty } from '../system-properties/SystemProperties'
import { ContentServerClient } from './clients/ContentServerClient'
import { ContentCluster } from './ContentCluster'
import { EventDeployer } from './EventDeployer'
import { DeploymentWithSource } from './streaming/EventStreamProcessor'
import { streamMap } from './streaming/StreamHelper'

export interface SynchronizationManager {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): void
}

export class ClusterSynchronizationManager implements SynchronizationManager {
  private static readonly LOGGER = log4js.getLogger('ClusterSynchronizationManager')
  private lastKnownDeployments: Map<ServerAddress, Timestamp>
  private syncWithNodesTimeout: NodeJS.Timeout
  private synchronizationState: SynchronizationState = SynchronizationState.BOOTSTRAPPING
  private stopping: boolean = false
  private timeOfLastSync: Timestamp = 0

  constructor(
    private readonly cluster: ContentCluster,
    private readonly systemProperties: SystemPropertiesManager,
    private readonly deployer: EventDeployer,
    private readonly timeBetweenSyncs: number,
    private readonly disableSynchronization: boolean,
    private readonly checkSyncRange: number
  ) {}

  async start(): Promise<void> {
    if (this.disableSynchronization) {
      ClusterSynchronizationManager.LOGGER.warn(`Cluster synchronization has been disabled.`)
      return
    }
    // Make sure the stopping flag is set to false
    this.stopping = false

    // Connect to the cluster
    await this.cluster.connect()

    // Read last deployments
    this.lastKnownDeployments = new Map(
      await this.systemProperties.getSystemProperty(SystemProperty.LAST_KNOWN_LOCAL_DEPLOYMENTS)
    )

    // Configure fail if sync hangs
    this.failIfSyncHangs().catch((e) =>
      ClusterSynchronizationManager.LOGGER.error('There was an error during the check of synchronization.')
    )

    // Sync with other servers
    await this.syncWithServers()
  }

  stop(): Promise<void> {
    if (this.disableSynchronization) {
      // Since it was disabled, there is nothing to stop
      return Promise.resolve()
    }
    this.stopping = true
    if (this.syncWithNodesTimeout) clearTimeout(this.syncWithNodesTimeout)
    this.cluster.disconnect()
    return this.waitUntilSyncFinishes()
  }

  getStatus() {
    const clusterStatus = this.cluster.getStatus()
    return {
      ...clusterStatus,
      synchronizationState: this.synchronizationState,
      lastSyncWithOtherServers: this.timeOfLastSync
    }
  }

  private async failIfSyncHangs(): Promise<void> {
    await delay(ms('30m'))

    while (true) {
      await delay(ms('5m'))

      const isSyncing: boolean = this.synchronizationState == SynchronizationState.SYNCING
      const lastSync: number = Date.now() - this.timeOfLastSync

      // If it is a lot of time in the syncing state and it has not stored new deployments, then we should restart the service
      if (isSyncing && lastSync > this.checkSyncRange) {
        ClusterSynchronizationManager.LOGGER.error(
          `Restarting server because the last sync was at least ${this.checkSyncRange} seconds ago, at: ${lastSync}`
        )
        process.exit(1)
      }
    }
  }

  // This is the method that is called recursive to sync with other catalysts
  private async syncWithServers(): Promise<void> {
    // Update flag: if it's not bootstrapping, then that means that it was synced and needs to get new deployments
    if (this.synchronizationState !== SynchronizationState.BOOTSTRAPPING) {
      this.synchronizationState = SynchronizationState.SYNCING
      metricsComponent.observe('dcl_sync_state_summary', { state: 'syncing' }, 1)
    } else {
      metricsComponent.observe('dcl_sync_state_summary', { state: 'bootstrapping' }, 1)
    }

    ClusterSynchronizationManager.LOGGER.debug(`Starting to sync with servers`)
    try {
      // Gather all servers
      const contentServers: ContentServerClient[] = this.cluster.getAllServersInCluster()

      // Fetch all new deployments
      const streams = contentServers.map((contentServer) => {
        const deploymentStream = contentServer.getNewDeployments()
        const sourceData = streamMap<DeploymentWithAuditInfo, DeploymentWithSource>((deployment) => ({
          deployment,
          source: contentServer
        }))
        return deploymentStream.pipe(sourceData)
      })

      // Process them together
      await this.deployer.processAllDeployments(
        streams,
        undefined,
        this.synchronizationState === SynchronizationState.BOOTSTRAPPING
      )

      ClusterSynchronizationManager.LOGGER.debug(`Updating content server timestamps`)

      // If everything worked, then update the last deployment timestamp
      contentServers.forEach((client) => {
        // Update the client, so it knows from when to ask next time
        const newTimestamp = client.allDeploymentsWereSuccessful()

        ClusterSynchronizationManager.LOGGER.debug(
          `Updating content server timestamps: ` + client.getAddress() + ' is ' + newTimestamp
        )
        // Update the map, so we can store it on the database
        this.lastKnownDeployments.set(client.getAddress(), newTimestamp)
      })

      ClusterSynchronizationManager.LOGGER.debug(`Updating system properties`)

      // Update the database
      await this.systemProperties.setSystemProperty(
        SystemProperty.LAST_KNOWN_LOCAL_DEPLOYMENTS,
        Array.from(this.lastKnownDeployments.entries())
      )

      this.synchronizationState = SynchronizationState.SYNCED
      metricsComponent.observe('dcl_sync_state_summary', { state: 'synced' }, 1)
      this.timeOfLastSync = Date.now()
      ClusterSynchronizationManager.LOGGER.debug(`Finished syncing with servers`)
    } catch (error) {
      this.synchronizationState = SynchronizationState.FAILED_TO_SYNC
      metricsComponent.observe('dcl_sync_state_summary', { state: 'failed_to_sync' }, 1)
      ClusterSynchronizationManager.LOGGER.error(`Failed to sync with servers. Reason:\n${error}`)
    } finally {
      if (!this.stopping) {
        // Set the timeout again
        this.syncWithNodesTimeout = setTimeout(() => this.syncWithServers(), this.timeBetweenSyncs)
      }
    }
  }

  private async waitUntilSyncFinishes(): Promise<void> {
    while (this.synchronizationState === SynchronizationState.SYNCING) {
      await delay(ms('1s'))
    }
  }
}
