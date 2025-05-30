// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const WEBSOCKET_HELLO = 'hello';

export type MessageListener = (msg: WebSocketMessage) => void;
export type FirstConnectListener = () => void;
export type ReconnectListener = () => void;
export type MissedMessageListener = () => void;
export type ErrorListener = (event: Event) => void;
export type CloseListener = (connectFailCount: number) => void;

export type WebSocketClientConfig = {
    maxWebSocketFails: number;
    minWebSocketRetryTime: number;
    maxWebSocketRetryTime: number;
    reconnectJitterRange: number;
    newWebSocketFn: (url: string) => WebSocket;
    clientPingInterval: number;
}

// Custom close error codes must be in the range of 4000-4999
const clientPingTimeoutErrCode = 4000;
const clientSequenceMismatchErrCode = 4001;

const defaultWebSocketClientConfig: WebSocketClientConfig = {
    maxWebSocketFails: 7,
    minWebSocketRetryTime: 3000, // 3 seconds
    maxWebSocketRetryTime: 300000, // 5 minutes
    reconnectJitterRange: 2000, // 2 seconds
    newWebSocketFn: (url: string) => {
        return new WebSocket(url);
    },
    clientPingInterval: 30000, // 30 seconds
};

export default class WebSocketClient {
    private config: WebSocketClientConfig;

    private conn: WebSocket | null;

    // responseSequence is the number to track a response sent
    // via the websocket. A response will always have the same sequence number
    // as the request.
    private responseSequence: number;

    // serverSequence is the incrementing sequence number from the
    // server-sent event stream.
    private serverSequence: number;
    private connectFailCount: number;
    private responseCallbacks: {[x: number]: ((msg: any) => void)};
    private lastErrCode: string | null;

    /**
     * @deprecated Use messageListeners instead
     */
    private eventCallback: MessageListener | null = null;

    /**
     * @deprecated Use firstConnectListeners instead
     */
    private firstConnectCallback: FirstConnectListener | null = null;

    /**
     * @deprecated Use reconnectListeners instead
     */
    private reconnectCallback: ReconnectListener | null = null;

    /**
     * @deprecated Use missedMessageListeners instead
     */
    private missedEventCallback: MissedMessageListener | null = null;

    /**
     * @deprecated Use errorListeners instead
     */
    private errorCallback: ErrorListener | null = null;

    /**
     * @deprecated Use closeListeners instead
     */
    private closeCallback: CloseListener | null = null;

    private messageListeners = new Set<MessageListener>();
    private firstConnectListeners = new Set<FirstConnectListener>();
    private reconnectListeners = new Set<ReconnectListener>();
    private missedMessageListeners = new Set<MissedMessageListener>();
    private errorListeners = new Set<ErrorListener>();
    private closeListeners = new Set<CloseListener>();

    private connectionId: string | null;
    private serverHostname: string | null;
    private postedAck: boolean;

    private pingInterval: ReturnType<typeof setInterval> | null;
    private waitingForPong: boolean;

    // reconnectTimeout is used for automatic reconnect after socket close
    private reconnectTimeout: ReturnType<typeof setTimeout> | null;

    // Network event handlers
    private onlineHandler: (() => void) | null = null;
    private offlineHandler: (() => void) | null = null;

    constructor(config?: Partial<WebSocketClientConfig>) {
        this.conn = null;
        this.responseSequence = 1;
        this.serverSequence = 0;
        this.connectFailCount = 0;
        this.responseCallbacks = {};
        this.connectionId = '';
        this.serverHostname = '';
        this.postedAck = false;
        this.reconnectTimeout = null;
        this.config = {...defaultWebSocketClientConfig, ...config};
        this.pingInterval = null;
        this.waitingForPong = false;
        this.lastErrCode = null;
    }

    // on connect, only send auth cookie and blank state.
    // on hello, get the connectionID and store it.
    // on reconnect, send cookie, connectionID, sequence number.
    initialize(connectionUrl: string, token?: string, postedAck?: boolean) {
        if (this.conn) {
            return;
        }

        // We have a timeout waiting to re-initialize the websocket.
        // We should wait until that fires before initializing,
        // otherwise we may not respect the configured backoff.
        if (this.reconnectTimeout) {
            return;
        }

        if (connectionUrl == null) {
            console.log('websocket must have connection url'); //eslint-disable-line no-console
            return;
        }

        if (this.connectFailCount === 0) {
            console.log('websocket connecting to ' + connectionUrl); //eslint-disable-line no-console
        }

        if (typeof postedAck != 'undefined') {
            this.postedAck = postedAck;
        }

        // Setup network event listener
        // Remove existing listeners if any
        if (this.onlineHandler) {
            window.removeEventListener('online', this.onlineHandler);
        }
        if (this.offlineHandler) {
            window.removeEventListener('offline', this.offlineHandler);
        }

        this.onlineHandler = () => {
            // If we're already connected, don't need to do anything
            if (this.conn && this.conn.readyState === WebSocket.OPEN) {
                return;
            }

            console.log('network online event received, scheduling reconnect'); // eslint-disable-line no-console

            // Set a timer to reconnect after a delay to avoid rapid connection attempts
            this.clearReconnectTimeout();
            this.reconnectTimeout = setTimeout(
                () => {
                    this.reconnectTimeout = null;
                    this.initialize(connectionUrl, token, this.postedAck);
                },
                this.config.minWebSocketRetryTime,
            );
        };

        this.offlineHandler = () => {
            // If we've detected a full disconnection, don't need to do anything more
            if (this.conn && this.conn.readyState !== WebSocket.OPEN) {
                return;
            }

            console.log('network offline event received, checking connection'); // eslint-disable-line no-console

            // If we haven't detected a full disconnection,
            // send a ping immediately to test the socket
            //
            // NOTE: There is a potential race condition here with the regular ping interval.
            // If we send this ping close to when the interval check occurs (e.g., at 29.5s of the 30s interval),
            // the server might not have enough time to respond before the interval executes.
            // When the interval runs, it will see we're still waiting for a pong and close the connection,
            // even though the network might be fine and the server just needs a bit more time to respond.
            // This race condition is rare and the impact is just an unnecessary reconnect,
            // so we accept this limitation to keep the implementation simple.
            this.waitingForPong = true;
            this.ping(() => {
                this.waitingForPong = false;
            });
        };

        window.addEventListener('online', this.onlineHandler);
        window.addEventListener('offline', this.offlineHandler);

        // Add connection id, and last_sequence_number to the query param.
        // We cannot use a cookie because it will bleed across tabs.
        // We cannot also send it as part of the auth_challenge, because the session cookie is already sent with the request.
        let websocketUrl = `${connectionUrl}?connection_id=${this.connectionId}&sequence_number=${this.serverSequence}`;

        if (this.postedAck) {
            websocketUrl += '&posted_ack=true';
        }

        if (this.lastErrCode) {
            websocketUrl += `&disconnect_err_code=${encodeURIComponent(this.lastErrCode)}`;
        }

        if (this.config.newWebSocketFn) {
            this.conn = this.config.newWebSocketFn(websocketUrl);
        } else {
            this.conn = new WebSocket(websocketUrl);
        }

        const onclose = (event: CloseEvent) => {
            this.conn = null;
            this.responseSequence = 1;

            if (!this.lastErrCode && event && event.code) {
                this.lastErrCode = `${event.code}`;
            }

            if (this.connectFailCount === 0) {
                console.log(`websocket closed: ${this.lastErrCode}`); //eslint-disable-line no-console
            }

            this.connectFailCount++;

            this.closeCallback?.(this.connectFailCount);
            this.closeListeners.forEach((listener) => listener(this.connectFailCount));

            // Make sure we stop pinging if the connection is closed
            this.stopPingInterval();

            // If we've failed a bunch of connections then start backing off
            let retryTime = this.config.minWebSocketRetryTime;
            if (this.connectFailCount > this.config.maxWebSocketFails) {
                retryTime = retryTime * this.connectFailCount * this.connectFailCount;
                if (retryTime > this.config.maxWebSocketRetryTime) {
                    retryTime = this.config.maxWebSocketRetryTime;
                }
            }

            // Applying jitter to avoid thundering herd problems.
            retryTime += Math.random() * this.config.reconnectJitterRange;

            // If we already have a reconnect timeout waiting,
            // we should let that handle the next connection.
            if (this.reconnectTimeout) {
                return;
            }

            this.reconnectTimeout = setTimeout(
                () => {
                    this.reconnectTimeout = null;
                    this.initialize(connectionUrl, token, this.postedAck);
                },
                retryTime,
            );
        };
        this.conn.onclose = onclose;

        this.conn.onopen = () => {
            if (token) {
                this.sendMessage('authentication_challenge', {token});
            }

            this.lastErrCode = null;

            if (this.connectFailCount > 0) {
                console.log('websocket re-established connection'); //eslint-disable-line no-console

                this.reconnectCallback?.();
                this.reconnectListeners.forEach((listener) => listener());
            } else if (this.firstConnectCallback || this.firstConnectListeners.size > 0) {
                this.firstConnectCallback?.();
                this.firstConnectListeners.forEach((listener) => listener());
            }

            this.stopPingInterval();

            // Send a ping immediately to test the socket
            this.waitingForPong = true;
            this.ping(() => {
                this.waitingForPong = false;
            });

            // And every 30 seconds after, checking to ensure
            // we're getting responses from the server
            this.pingInterval = setInterval(
                () => {
                    if (!this.waitingForPong) {
                        this.waitingForPong = true;
                        this.ping(() => {
                            this.waitingForPong = false;
                        });
                        return;
                    }

                    this.stopPingInterval();

                    // If we aren't connected, we should already be trying to
                    // re-connect the websocket. So there's nothing more to do here.
                    if (!this.conn || this.conn.readyState !== WebSocket.OPEN) {
                        return;
                    }

                    console.log('ping received no response within time limit: re-establishing websocket'); //eslint-disable-line no-console

                    const closeEvent = new CloseEvent('close', {
                        code: clientPingTimeoutErrCode,
                        wasClean: false,
                    });

                    // Calling conn.close() will trigger the onclose callback,
                    // but sometimes with a significant delay. So instead, we
                    // call the onclose callback ourselves immediately. We also
                    // unset the callback on the old connection to ensure it
                    // is only called once.
                    this.connectFailCount = 0;
                    this.responseSequence = 1;
                    this.conn.onclose = () => {};
                    this.conn.close();
                    onclose(closeEvent);
                },
                this.config.clientPingInterval);

            this.connectFailCount = 0;
        };

        this.conn.onerror = (evt) => {
            if (this.connectFailCount <= 1) {
                console.log('websocket error'); //eslint-disable-line no-console
                console.log(evt); //eslint-disable-line no-console
            }

            this.errorCallback?.(evt);
            this.errorListeners.forEach((listener) => listener(evt));
        };

        this.conn.onmessage = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.seq_reply) {
                // This indicates a reply to a websocket request.
                // We ignore sequence number validation of message responses
                // and only focus on the purely server side event stream.
                if (msg.error) {
                    console.log(msg); //eslint-disable-line no-console
                }

                if (this.responseCallbacks[msg.seq_reply]) {
                    this.responseCallbacks[msg.seq_reply](msg);
                    Reflect.deleteProperty(this.responseCallbacks, msg.seq_reply);
                }
            } else if (this.eventCallback || this.messageListeners.size > 0) {
                // We check the hello packet, which is always the first packet in a stream.
                if (msg.event === WEBSOCKET_HELLO && (this.missedEventCallback || this.missedMessageListeners.size > 0)) {
                    console.log('got connection id ', msg.data.connection_id); //eslint-disable-line no-console
                    // If we already have a connectionId present, and server sends a different one,
                    // that means it's either a long timeout, or server restart, or sequence number is not found.
                    // Then we do the sync calls, and reset sequence number to 0.
                    if (this.connectionId !== '' && this.connectionId !== msg.data.connection_id) {
                        console.log('long timeout, or server restart, or sequence number is not found.'); //eslint-disable-line no-console

                        this.missedEventCallback?.();

                        for (const listener of this.missedMessageListeners) {
                            try {
                                listener();
                            } catch (e) {
                                console.log(`missed message listener "${listener.name}" failed: ${e}`); // eslint-disable-line no-console
                            }
                        }

                        this.serverSequence = 0;
                    }

                    // If it's a fresh connection, we have to set the connectionId regardless.
                    // And if it's an existing connection, setting it again is harmless, and keeps the code simple.
                    this.connectionId = msg.data.connection_id;

                    // Also update the server hostname
                    this.serverHostname = msg.data.server_hostname;
                }

                // Now we check for sequence number, and if it does not match,
                // we just disconnect and reconnect.
                if (msg.seq !== this.serverSequence) {
                    console.log('missed websocket event, act_seq=' + msg.seq + ' exp_seq=' + this.serverSequence); //eslint-disable-line no-console

                    const closeEvent = new CloseEvent('close', {
                        code: clientSequenceMismatchErrCode,
                        wasClean: false,
                    });

                    // Calling conn.close() will trigger the onclose callback,
                    // but sometimes with a significant delay. So instead, we
                    // call the onclose callback ourselves immediately. We also
                    // unset the callback on the old connection to ensure it
                    // is only called once.
                    this.connectFailCount = 0;
                    this.responseSequence = 1;
                    if (this.conn) {
                        this.conn.onclose = () => {};
                        this.conn.close();
                        onclose(closeEvent);
                    }
                    return;
                }
                this.serverSequence = msg.seq + 1;

                this.eventCallback?.(msg);
                this.messageListeners.forEach((listener) => listener(msg));
            }
        };
    }

    /**
     * @deprecated Use addMessageListener instead
     */
    setEventCallback(callback: MessageListener) {
        this.eventCallback = callback;
    }

    addMessageListener(listener: MessageListener) {
        this.messageListeners.add(listener);

        if (this.messageListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.messageListeners.size} message listeners registered`);
        }
    }

    removeMessageListener(listener: MessageListener) {
        this.messageListeners.delete(listener);
    }

    /**
     * @deprecated Use addFirstConnectListener instead
     */
    setFirstConnectCallback(callback: FirstConnectListener) {
        this.firstConnectCallback = callback;
    }

    addFirstConnectListener(listener: FirstConnectListener) {
        this.firstConnectListeners.add(listener);

        if (this.firstConnectListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.firstConnectListeners.size} first connect listeners registered`);
        }
    }

    removeFirstConnectListener(listener: FirstConnectListener) {
        this.firstConnectListeners.delete(listener);
    }

    /**
     * @deprecated Use addReconnectListener instead
     */
    setReconnectCallback(callback: ReconnectListener) {
        this.reconnectCallback = callback;
    }

    addReconnectListener(listener: ReconnectListener) {
        this.reconnectListeners.add(listener);

        if (this.reconnectListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.reconnectListeners.size} reconnect listeners registered`);
        }
    }

    removeReconnectListener(listener: ReconnectListener) {
        this.reconnectListeners.delete(listener);
    }

    /**
     * @deprecated Use addMissedMessageListener instead
     */
    setMissedEventCallback(callback: MissedMessageListener) {
        this.missedEventCallback = callback;
    }

    addMissedMessageListener(listener: MissedMessageListener) {
        this.missedMessageListeners.add(listener);

        if (this.missedMessageListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.missedMessageListeners.size} missed message listeners registered`);
        }
    }

    removeMissedMessageListener(listener: MissedMessageListener) {
        this.missedMessageListeners.delete(listener);
    }

    /**
     * @deprecated Use addErrorListener instead
     */
    setErrorCallback(callback: ErrorListener) {
        this.errorCallback = callback;
    }

    addErrorListener(listener: ErrorListener) {
        this.errorListeners.add(listener);

        if (this.errorListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.errorListeners.size} error listeners registered`);
        }
    }

    removeErrorListener(listener: ErrorListener) {
        this.errorListeners.delete(listener);
    }

    /**
     * @deprecated Use addCloseListener instead
     */
    setCloseCallback(callback: CloseListener) {
        this.closeCallback = callback;
    }

    addCloseListener(listener: CloseListener) {
        this.closeListeners.add(listener);

        if (this.closeListeners.size > 5) {
            // eslint-disable-next-line no-console
            console.warn(`WebSocketClient has ${this.closeListeners.size} close listeners registered`);
        }
    }

    removeCloseListener(listener: CloseListener) {
        this.closeListeners.delete(listener);
    }

    close() {
        this.connectFailCount = 0;
        this.responseSequence = 1;
        this.clearReconnectTimeout();
        this.lastErrCode = null;
        this.stopPingInterval();

        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.onclose = () => {};
            this.conn.close();
            this.conn = null;
            console.log('websocket closed manually'); //eslint-disable-line no-console
        }

        if (this.onlineHandler) {
            window.removeEventListener('online', this.onlineHandler);
            this.onlineHandler = null;
        }
        if (this.offlineHandler) {
            window.removeEventListener('offline', this.offlineHandler);
            this.offlineHandler = null;
        }
    }

    clearReconnectTimeout() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    ping(responseCallback?: (msg: any) => void) {
        const msg = {
            action: 'ping',
            seq: this.responseSequence++,
        };

        if (responseCallback) {
            this.responseCallbacks[msg.seq] = responseCallback;
        }

        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.send(JSON.stringify(msg));
        }
    }

    sendMessage(action: string, data: any, responseCallback?: (msg: any) => void) {
        const msg = {
            action,
            seq: this.responseSequence++,
            data,
        };

        if (responseCallback) {
            this.responseCallbacks[msg.seq] = responseCallback;
        }

        // Only try to send the message if the websocket is open.
        // If the websocket is closed here, we will drop the message.
        if (this.conn && this.conn.readyState === WebSocket.OPEN) {
            this.conn.send(JSON.stringify(msg));
        }
    }

    userTyping(channelId: string, parentId: string, callback?: () => void) {
        const data = {
            channel_id: channelId,
            parent_id: parentId,
        };
        this.sendMessage('user_typing', data, callback);
    }

    updateActiveChannel(channelId: string, callback?: (msg: any) => void) {
        const data = {
            channel_id: channelId,
        };
        this.sendMessage('presence', data, callback);
    }

    updateActiveTeam(teamId: string, callback?: (msg: any) => void) {
        const data = {
            team_id: teamId,
        };
        this.sendMessage('presence', data, callback);
    }

    updateActiveThread(isThreadView: boolean, channelId: string, callback?: (msg: any) => void) {
        const data = {
            thread_channel_id: channelId,
            is_thread_view: isThreadView,
        };
        this.sendMessage('presence', data, callback);
    }

    userUpdateActiveStatus(userIsActive: boolean, manual: boolean, callback?: () => void) {
        const data = {
            user_is_active: userIsActive,
            manual,
        };
        this.sendMessage('user_update_active_status', data, callback);
    }

    acknowledgePostedNotification(postId: string, status: string, reason?: string, postedData?: string) {
        const data = {
            post_id: postId,
            user_agent: window.navigator.userAgent,
            status,
            reason,
            data: postedData,
        };

        this.sendMessage('posted_notify_ack', data);
    }

    getStatuses(callback?: () => void) {
        this.sendMessage('get_statuses', null, callback);
    }

    getStatusesByIds(userIds: string[], callback?: () => void) {
        const data = {
            user_ids: userIds,
        };
        this.sendMessage('get_statuses_by_ids', data, callback);
    }
}

export type WebSocketBroadcast = {
    omit_users: Record<string, boolean>;
    user_id: string;
    channel_id: string;
    team_id: string;
}

export type WebSocketMessage<T = any> = {
    event: string;
    data: T;
    broadcast: WebSocketBroadcast;
    seq: number;
}
