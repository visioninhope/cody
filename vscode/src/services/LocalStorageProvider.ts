import * as uuid from 'uuid'
import type { Memento } from 'vscode'

import {
    type AuthStatus,
    type ChatHistory,
    type ConfigurationWithAccessToken,
    type SerializedChatInteraction,
    type SerializedChatMessage,
    type UserLocalHistory,
    logDebug,
} from '@sourcegraph/cody-shared'

import { isSourcegraphToken } from '../chat/protocol'

export interface AsyncMemento {
    keys(): Promise<readonly string[]>
    get<T>(key: string, defaultValue: T): Promise<T>
    update(key: string, value: any): Promise<void>
}

function convertToAsyncStore(store: Memento | AsyncMemento): AsyncMemento {
    return {
        keys: (): Promise<readonly string[]> => {
            return Promise.resolve(store.keys())
        },
        get<T>(key: string, defaultValue?: T): Promise<T> {
            return Promise.resolve(store.get(key, defaultValue) as T)
        },
        update(key: string, value: any): Promise<void> {
            store.update(key, value)

            return Promise.resolve()
        },
    }
}

type ChatHistoryKey = `${string}-${string}`
type AccountKeyedChatHistory = {
    [key: ChatHistoryKey]: PersistedUserLocalHistory
}

interface PersistedUserLocalHistory {
    chat: ChatHistory
}

class LocalStorage {
    // Bump this on storage changes so we don't handle incorrectly formatted data
    protected readonly KEY_LOCAL_HISTORY = 'cody-local-chatHistory-v2'
    protected readonly KEY_CONFIG = 'cody-config'
    protected readonly KEY_LOCAL_MINION_HISTORY = 'cody-local-minionHistory-v0'
    public readonly ANONYMOUS_USER_ID_KEY = 'sourcegraphAnonymousUid'
    public readonly LAST_USED_ENDPOINT = 'SOURCEGRAPH_CODY_ENDPOINT'
    protected readonly CODY_ENDPOINT_HISTORY = 'SOURCEGRAPH_CODY_ENDPOINT_HISTORY'
    protected readonly CODY_ENROLLMENT_HISTORY = 'SOURCEGRAPH_CODY_ENROLLMENTS'

    /**
     * Should be set on extension activation via `localStorage.setStorage(context.globalState)`
     * Done to avoid passing the local storage around as a parameter and instead
     * access it as a singleton via the module import.
     */
    private _storage: AsyncMemento | null = null

    private get storage(): AsyncMemento {
        if (!this._storage) {
            throw new Error('LocalStorage not initialized')
        }

        return this._storage
    }

    public setStorage(storage: Memento | AsyncMemento): void {
        // We don't know in runtime which store time we have sync/async
        // convert it to async (it has no effect on already sync store)
        this._storage = convertToAsyncStore(storage)
    }

    public async getEndpoint(): Promise<string | null> {
        const endpoint = await this.storage.get<string | null>(this.LAST_USED_ENDPOINT, null)
        // Clear last used endpoint if it is a Sourcegraph token
        if (endpoint && isSourcegraphToken(endpoint)) {
            void this.deleteEndpoint()
            return null
        }
        return endpoint
    }

    public async saveEndpoint(endpoint: string): Promise<void> {
        if (!endpoint) {
            return
        }
        try {
            // Do not save sourcegraph tokens as the last used endpoint
            if (isSourcegraphToken(endpoint)) {
                return
            }

            const uri = new URL(endpoint).href
            await this.storage.update(this.LAST_USED_ENDPOINT, uri)
            await this.addEndpointHistory(uri)
        } catch (error) {
            console.error(error)
        }
    }

    public async deleteEndpoint(): Promise<void> {
        await this.storage.update(this.LAST_USED_ENDPOINT, null)
    }

    public getEndpointHistory(): Promise<string[] | null> {
        return this.storage.get<string[] | null>(this.CODY_ENDPOINT_HISTORY, null)
    }

    private async addEndpointHistory(endpoint: string): Promise<void> {
        // Do not save sourcegraph tokens as endpoint
        if (isSourcegraphToken(endpoint)) {
            return
        }

        const history = await this.storage.get<string[] | null>(this.CODY_ENDPOINT_HISTORY, null)
        const historySet = new Set(history)
        historySet.delete(endpoint)
        historySet.add(endpoint)
        await this.storage.update(this.CODY_ENDPOINT_HISTORY, [...historySet])
    }

    public async getChatHistory(authStatus: AuthStatus): Promise<UserLocalHistory> {
        const history = await this.storage.get<AccountKeyedChatHistory | null>(
            this.KEY_LOCAL_HISTORY,
            null
        )
        const accountKey = getKeyForAuthStatus(authStatus)

        // Migrate chat history to set the `ChatMessage.model` property on each assistant message
        // instead of `chatModel` on the overall transcript. Can remove when
        // `SerializedChatTranscript.chatModel` property is removed in v1.22.
        const migratedHistory = migrateHistoryForChatModelProperty(history)
        if (history !== migratedHistory) {
            this.storage.update(this.KEY_LOCAL_HISTORY, migratedHistory).then(() => {}, console.error)
        }

        return migratedHistory?.[accountKey] ?? { chat: {} }
    }

    public async setChatHistory(authStatus: AuthStatus, history: UserLocalHistory): Promise<void> {
        try {
            const key = getKeyForAuthStatus(authStatus)
            let fullHistory = await this.storage.get<{ [key: ChatHistoryKey]: UserLocalHistory } | null>(
                this.KEY_LOCAL_HISTORY,
                null
            )

            if (fullHistory) {
                fullHistory[key] = history
            } else {
                fullHistory = {
                    [key]: history,
                }
            }

            await this.storage.update(this.KEY_LOCAL_HISTORY, fullHistory)
        } catch (error) {
            console.error(error)
        }
    }

    public async deleteChatHistory(authStatus: AuthStatus, chatID: string): Promise<void> {
        const userHistory = await this.getChatHistory(authStatus)
        if (userHistory) {
            try {
                delete userHistory.chat[chatID]
                await this.setChatHistory(authStatus, userHistory)
            } catch (error) {
                console.error(error)
            }
        }
    }

    public async setMinionHistory(authStatus: AuthStatus, serializedHistory: string): Promise<void> {
        // TODO(beyang): SECURITY - use authStatus
        await this.storage.update(this.KEY_LOCAL_MINION_HISTORY, serializedHistory)
    }

    public async getMinionHistory(authStatus: AuthStatus): Promise<string | null> {
        // TODO(beyang): SECURITY - use authStatus
        return this.storage.get<string | null>(this.KEY_LOCAL_MINION_HISTORY, null)
    }

    public async removeChatHistory(authStatus: AuthStatus): Promise<void> {
        try {
            await this.setChatHistory(authStatus, { chat: {} })
        } catch (error) {
            console.error(error)
        }
    }

    /**
     * Gets the enrollment history for a feature from the storage.
     *
     * Checks if the given feature name exists in the stored enrollment
     * history array.
     *
     * If not, add the feature to the memory, but return false after adding the feature
     * so that the caller can log the first enrollment event.
     */
    public async getEnrollmentHistory(featureName: string): Promise<boolean> {
        const history = await this.storage.get<string[]>(this.CODY_ENROLLMENT_HISTORY, [])
        const hasEnrolled = history.includes(featureName)

        // Log the first enrollment event
        if (!hasEnrolled) {
            history.push(featureName)
            void this.storage.update(this.CODY_ENROLLMENT_HISTORY, history)
        }

        return hasEnrolled
    }

    /**
     * Return the anonymous user ID stored in local storage or create one if none exists (which
     * occurs on a fresh installation).
     */
    public async anonymousUserID(): Promise<{ anonymousUserID: string; created: boolean }> {
        let id = await this.storage.get<string | null>(this.ANONYMOUS_USER_ID_KEY, null)
        let created = false
        if (!id) {
            created = true
            id = uuid.v4()
            try {
                await this.storage.update(this.ANONYMOUS_USER_ID_KEY, id)
            } catch (error) {
                console.error(error)
            }
        }
        return { anonymousUserID: id, created }
    }

    public async setConfig(config: ConfigurationWithAccessToken): Promise<void> {
        return this.set(this.KEY_CONFIG, config)
    }

    public getConfig(): Promise<ConfigurationWithAccessToken | null> {
        return this.get(this.KEY_CONFIG)
    }

    public get<T>(key: string): Promise<T | null> {
        return this.storage.get(key, null)
    }

    public async set<T>(key: string, value: T): Promise<void> {
        try {
            await this.storage.update(key, value)
        } catch (error) {
            console.error(error)
        }
    }

    public async delete(key: string): Promise<void> {
        await this.storage.update(key, undefined)
    }
}

/**
 * Singleton instance of the local storage provider.
 * The underlying storage is set on extension activation via `localStorage.setStorage(context.globalState)`.
 */
export const localStorage = new LocalStorage()

function getKeyForAuthStatus(authStatus: AuthStatus): ChatHistoryKey {
    return `${authStatus.endpoint}-${authStatus.username}`
}

/**
 * Migrate chat history to set the {@link ChatMessage.model} property on each assistant message
 * instead of {@link SerializedChatTranscript.chatModel} on the overall transcript. Can remove when
 * {@link SerializedChatTranscript.chatModel} property is removed in v1.22.
 */
function migrateHistoryForChatModelProperty(
    history: AccountKeyedChatHistory | null
): AccountKeyedChatHistory | null {
    if (!history) {
        return null
    }

    let neededMigration = 0
    function migrateAssistantMessage(
        assistantMessage: SerializedChatMessage,
        model: string | undefined
    ): SerializedChatMessage {
        if (assistantMessage.model) {
            return assistantMessage
        }
        neededMigration++
        return {
            ...assistantMessage,
            model: model ?? 'unknown',
        }
    }

    const migratedHistory = Object.fromEntries(
        Object.entries(history).map(([accountKey, userLocalHistory]) => [
            accountKey,
            {
                chat: userLocalHistory.chat
                    ? Object.fromEntries(
                          Object.entries(userLocalHistory.chat).map(([id, transcript]) => [
                              id,
                              transcript
                                  ? {
                                        ...transcript,
                                        interactions: transcript.interactions.map(
                                            interaction =>
                                                ({
                                                    ...interaction,
                                                    assistantMessage: interaction.assistantMessage
                                                        ? migrateAssistantMessage(
                                                              interaction.assistantMessage,
                                                              transcript.chatModel
                                                          )
                                                        : null,
                                                }) satisfies SerializedChatInteraction
                                        ),
                                    }
                                  : transcript,
                          ])
                      )
                    : {},
            },
        ])
    )
    if (neededMigration) {
        logDebug('migrateHistoryForChatModelProperty', `${neededMigration} chat messages migrated`)
        return migratedHistory
    }
    return history
}
