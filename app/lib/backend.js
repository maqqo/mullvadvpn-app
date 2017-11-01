// @flow

import log from 'electron-log';
import EventEmitter from 'events';
import { servers } from '../config';
import { IpcFacade, RealIpc } from './ipc-facade';
import accountActions from '../redux/account/actions';
import connectionActions from '../redux/connection/actions';
import settingsActions from '../redux/settings/actions';
import { push } from 'react-router-redux';
import { defaultServer } from '../config';

import type { ReduxStore } from '../redux/store';
import type { BackendState, RelayConstraintsUpdate } from './ipc-facade';
import type { ConnectionState } from '../redux/connection/reducers';

export type EventType = 'connect' | 'connecting' | 'disconnect' | 'login' | 'logging' | 'logout' | 'updatedIp' | 'updatedLocation' | 'updatedReachability';
export type ErrorType = 'NO_CREDIT' | 'NO_INTERNET' | 'INVALID_ACCOUNT' | 'NO_ACCOUNT';

export type ServerInfo = {
  address: string,
  name: string,
  city: string,
  country: string,
  location: [number, number]
};

export type ServerInfoList = { [string]: ServerInfo };

export class BackendError extends Error {
  type: ErrorType;
  title: string;
  message: string;

  constructor(type: ErrorType) {
    super('');
    this.type = type;
    this.title = BackendError.localizedTitle(type);
    this.message = BackendError.localizedMessage(type);
  }

  static localizedTitle(type: ErrorType): string {
    switch(type) {
    case 'NO_CREDIT':
      return 'Out of time';
    case 'NO_INTERNET':
      return 'Offline';
    default:
      return 'Something went wrong';
    }
  }

  static localizedMessage(type: ErrorType): string {
    switch(type) {
    case 'NO_CREDIT':
      return 'Buy more time, so you can continue using the internet securely';
    case 'NO_INTERNET':
      return 'Your internet connection will be secured when you get back online';
    case 'INVALID_ACCOUNT':
      return 'Invalid account number';
    case 'NO_ACCOUNT':
      return 'No account was set';
    default:
      return '';
    }
  }

}


export type IpcCredentials = {
  connectionString: string,
  sharedSecret: string,
};
export function parseIpcCredentials(data: string): ?IpcCredentials {
  const [connectionString, sharedSecret] = data.split('\n', 2);
  if(connectionString && sharedSecret) {
    return {
      connectionString,
      sharedSecret,
    };
  } else {
    return null;
  }
}


/**
 * Backend implementation
 */
export class Backend {

  _ipc: IpcFacade;
  _credentials: ?IpcCredentials;
  _authenticationPromise: ?Promise<void>;
  _store: ReduxStore;
  _eventEmitter = new EventEmitter();

  constructor(store: ReduxStore, credentials?: IpcCredentials, ipc: ?IpcFacade) {
    this._store = store;
    this._credentials = credentials;


    if(ipc) {
      this._ipc = ipc;

      // force to re-authenticate when connection closed
      this._ipc.setCloseConnectionHandler(() => {
        this._authenticationPromise = null;
      });

      this._registerIpcListeners();
      this._startReachability();
    }
  }

  setCredentials(credentials: IpcCredentials) {
    log.debug('Got connection info to backend', credentials.connectionString);
    this._credentials = credentials;

    if (this._ipc) {
      this._credentials = credentials;
    } else {
      this._ipc = new RealIpc(credentials.connectionString);

      // force to re-authenticate when connection closed
      this._ipc.setCloseConnectionHandler(() => {
        this._authenticationPromise = null;
      });
    }
    this._registerIpcListeners();
  }

  sync() {
    log.info('Syncing with the backend...');

    this._ensureAuthenticated()
      .then( () => {
        this._ipc.getIp()
          .then( ip => {
            log.info('Got ip', ip);
            this._store.dispatch(connectionActions.newPublicIp(ip));
          })
          .catch(e => {
            log.info('Failed syncing with the backend,', e.message);
          });
      });

    this._ensureAuthenticated()
      .then( () => {
        this._ipc.getLocation()
          .then( location => {
            log.info('Got location', location);
            const newLocation = {
              location: location.latlong,
              country: location.country,
              city: location.city
            };
            this._store.dispatch(connectionActions.newLocation(newLocation));
          })
          .catch(e => {
            log.info('Failed getting new location,', e.message);
          });
      });
  }

  serverInfo(identifier: string): ?ServerInfo {
    return (servers: ServerInfoList)[identifier];
  }

  login(accountToken: string): Promise<void> {
    log.debug('Attempting to login with account number', accountToken);

    this._store.dispatch(accountActions.startLogin(accountToken));

    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.getAccountData(accountToken)
          .then( response => {
            log.debug('Account exists', response);

            return this._ipc.setAccount(accountToken)
              .then( () => response );

          }).then( accountData => {
            log.info('Log in complete');

            this._store.dispatch(accountActions.loginSuccessful(accountData.expiry));

            // Redirect the user after some time to allow for
            // the 'Login Successful' screen to be visible
            setTimeout(() => {
              this._store.dispatch(push('/connect'));
              this.connect();
            }, 1000);
          }).catch(e => {
            log.error('Failed to log in,', e.message);

            // TODO: This is not true. If there is a communication link failure the promise will be rejected too
            const err = new BackendError('INVALID_ACCOUNT');
            this._store.dispatch(accountActions.loginFailed(err));
          });
      });
  }

  autologin() {
    log.debug('Attempting to log in automatically');

    this._store.dispatch(accountActions.startLogin());

    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.getAccount()
          .then( accountToken => {
            if (!accountToken) {
              throw new BackendError('NO_ACCOUNT');
            }
            log.debug('The backend had an account number stored:', accountToken);
            this._store.dispatch(accountActions.startLogin(accountToken));

            return this._ipc.getAccountData(accountToken);
          })
          .then( accountData => {
            log.debug('The stored account number still exists', accountData);

            this._store.dispatch(accountActions.loginSuccessful(accountData.expiry));

            this._store.dispatch(push('/connect'));
            this.connect();
          })
          .catch( e => {
            log.warn('Unable to autologin,', e.message);

            this._store.dispatch(accountActions.autoLoginFailed());
            this._store.dispatch(push('/'));

            throw e;
          });
      });
  }

  logout() {
    // @TODO: What does it mean for a logout to be successful or failed?
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.setAccount(null)
          .then(() => {

            this._store.dispatch(accountActions.loggedOut());

            // disconnect user during logout
            return this.disconnect()
              .then( () => {
                this._store.dispatch(push('/'));
              });
          })
          .catch(e => {
            log.info('Failed to logout,', e.message);
          });
      });
  }

  connect(aHost?: string): Promise<void> {
    const host = aHost;

    let setHostPromise = () => Promise.resolve();
    if (host) {
      this._store.dispatch(connectionActions.connectingTo(host || 'unknown'));
      setHostPromise = () => this._ipc.updateRelayConstraints({
        host: { only: host },
        tunnel: { openvpn: {
        }},
      });
    }

    return this._ensureAuthenticated()
      .then( setHostPromise )
      .then( () => this._ipc.connect() )
      .catch(e => {
        log.info('Failed connecting to the relay set in the backend, ', e.message);
        this._store.dispatch(connectionActions.disconnected());
      });
  }

  disconnect(): Promise<void> {
    // @TODO: Failure modes
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.disconnect()
          .catch(e => {
            log.info('Failed to disconnect,', e.message);
          });
      });
  }

  shutdown(): Promise<void> {
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.shutdown();
      });
  }

  updateRelayConstraints(relayConstraints: RelayConstraintsUpdate): Promise<void> {
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.updateRelayConstraints(relayConstraints);
      });
  }

  syncRelayConstraints(): Promise<void> {
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.getRelayContraints();
      })
      .then( constraints => {
        log.debug('Got constraints from backend', constraints);

        const host = constraints.host === 'any'
          ? defaultServer
          : constraints.host || defaultServer;

        this._store.dispatch(settingsActions.updateRelay({
          host: host,
          tunnel: constraints.tunnel,
        }));
      })
      .catch( e => {
        log.error('Failed getting relay constraints', e);
      });
  }

  /**
   * Start reachability monitoring for online/offline detection
   * This is currently done via HTML5 APIs but will be replaced later
   * with proper backend integration.
   */
  _startReachability() {
    window.addEventListener('online', () => {
      this._store.dispatch(connectionActions.online());
    });
    window.addEventListener('offline', () => {
      // force disconnect since there is no real connection anyway.
      this.disconnect();
      this._store.dispatch(connectionActions.offline());
    });

    // update online status in background
    setTimeout(() => {
      const action = navigator.onLine
        ? connectionActions.online()
        : connectionActions.offline();

      this._store.dispatch(action);
    }, 0);
  }

  _registerIpcListeners() {
    return this._ensureAuthenticated()
      .then( () => {
        return this._ipc.registerStateListener(newState => {
          log.debug('Got new state from backend', newState);

          const newStatus = this._securityStateToConnectionState(newState);
          switch(newStatus) {
          case 'connecting':
            this._store.dispatch(connectionActions.connecting());
            break;
          case 'connected':
            this._store.dispatch(connectionActions.connected());
            break;
          case 'disconnected':
            this._store.dispatch(connectionActions.disconnected());
            break;
          }

          this.sync();
        });
      });
  }

  _securityStateToConnectionState(backendState: BackendState): ConnectionState {
    if (backendState.state === 'unsecured' && backendState.target_state === 'secured') {
      return 'connecting';
    } else if (backendState.state === 'secured' && backendState.target_state === 'secured') {
      return 'connected';
    } else if (backendState.target_state === 'unsecured') {
      return 'disconnected';
    }
    throw new Error('Unsupported state/target state combination: ' + JSON.stringify(backendState));
  }

  _ensureAuthenticated(): Promise<void> {
    const credentials = this._credentials;
    if(credentials) {
      if(!this._authenticationPromise) {
        this._authenticationPromise = this._authenticate(credentials.sharedSecret);
      }
      return this._authenticationPromise;
    } else {
      return Promise.reject(new Error('Missing authentication credentials.'));
    }
  }

  _authenticate(sharedSecret: string): Promise<void> {
    return this._ipc.authenticate(sharedSecret)
      .then(() => {
        log.info('Authenticated with backend');
      })
      .catch((e) => {
        log.error('Failed to authenticate with backend: ', e.message);
        throw e;
      });
  }
}
