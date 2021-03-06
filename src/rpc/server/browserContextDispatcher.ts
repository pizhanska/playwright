/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as types from '../../types';
import { BrowserContextBase, BrowserContext } from '../../browserContext';
import { Events } from '../../events';
import { Dispatcher, DispatcherScope, lookupNullableDispatcher, lookupDispatcher } from './dispatcher';
import { PageDispatcher, BindingCallDispatcher, WorkerDispatcher } from './pageDispatcher';
import { PageChannel, BrowserContextChannel, BrowserContextInitializer, CDPSessionChannel } from '../channels';
import { RouteDispatcher, RequestDispatcher } from './networkDispatchers';
import { Page } from '../../page';
import { CRBrowserContext } from '../../chromium/crBrowser';
import { CDPSessionDispatcher } from './cdpSessionDispatcher';
import { Events as ChromiumEvents } from '../../chromium/events';

export class BrowserContextDispatcher extends Dispatcher<BrowserContext, BrowserContextInitializer> implements BrowserContextChannel {
  private _context: BrowserContextBase;

  constructor(scope: DispatcherScope, context: BrowserContextBase) {
    let crBackgroundPages: PageDispatcher[] = [];
    let crServiceWorkers: WorkerDispatcher[] = [];
    if (context._browserBase._options.name === 'chromium') {
      crBackgroundPages = (context as CRBrowserContext).backgroundPages().map(p => new PageDispatcher(scope, p));
      context.on(ChromiumEvents.CRBrowserContext.BackgroundPage, page => this._dispatchEvent('crBackgroundPage', new PageDispatcher(this._scope, page)));
      crServiceWorkers = (context as CRBrowserContext).serviceWorkers().map(w => new WorkerDispatcher(scope, w));
      context.on(ChromiumEvents.CRBrowserContext.ServiceWorker, serviceWorker => this._dispatchEvent('crServiceWorker', new WorkerDispatcher(this._scope, serviceWorker)));
    }

    super(scope, context, 'context', {
      pages: context.pages().map(p => new PageDispatcher(scope, p)),
      crBackgroundPages,
      crServiceWorkers,
    }, true);
    this._context = context;
    context.on(Events.BrowserContext.Page, page => this._dispatchEvent('page', new PageDispatcher(this._scope, page)));
    context.on(Events.BrowserContext.Close, () => {
      this._dispatchEvent('close');
      this._scope.dispose();
    });
  }

  async setDefaultNavigationTimeoutNoReply(params: { timeout: number }) {
    this._context.setDefaultNavigationTimeout(params.timeout);
  }

  async setDefaultTimeoutNoReply(params: { timeout: number }) {
    this._context.setDefaultTimeout(params.timeout);
  }

  async exposeBinding(params: { name: string }): Promise<void> {
    await this._context.exposeBinding(params.name, (source, ...args) => {
      const bindingCall = new BindingCallDispatcher(this._scope, params.name, source, args);
      this._dispatchEvent('bindingCall', bindingCall);
      return bindingCall.promise();
    });
  }

  async newPage(): Promise<PageChannel> {
    return lookupDispatcher<PageDispatcher>(await this._context.newPage());
  }

  async cookies(params: { urls: string[] }): Promise<types.NetworkCookie[]> {
    return await this._context.cookies(params.urls);
  }

  async addCookies(params: { cookies: types.SetNetworkCookieParam[] }): Promise<void> {
    await this._context.addCookies(params.cookies);
  }

  async clearCookies(): Promise<void> {
    await this._context.clearCookies();
  }

  async grantPermissions(params: { permissions: string[], options: { origin?: string } }): Promise<void> {
    await this._context.grantPermissions(params.permissions, params.options);
  }

  async clearPermissions(): Promise<void> {
    await this._context.clearPermissions();
  }

  async setGeolocation(params: { geolocation: types.Geolocation | null }): Promise<void> {
    await this._context.setGeolocation(params.geolocation);
  }

  async setExtraHTTPHeaders(params: { headers: types.Headers }): Promise<void> {
    await this._context.setExtraHTTPHeaders(params.headers);
  }

  async setOffline(params: { offline: boolean }): Promise<void> {
    await this._context.setOffline(params.offline);
  }

  async setHTTPCredentials(params: { httpCredentials: types.Credentials | null }): Promise<void> {
    await this._context.setHTTPCredentials(params.httpCredentials);
  }

  async addInitScript(params: { source: string }): Promise<void> {
    await this._context._doAddInitScript(params.source);
  }

  async setNetworkInterceptionEnabled(params: { enabled: boolean }): Promise<void> {
    if (!params.enabled) {
      await this._context.unroute('**/*');
      return;
    }
    this._context.route('**/*', (route, request) => {
      this._dispatchEvent('route', { route: new RouteDispatcher(this._scope, route), request: RequestDispatcher.from(this._scope, request) });
    });
  }

  async waitForEvent(params: { event: string }): Promise<any> {
    const result = await this._context.waitForEvent(params.event);
    if (result instanceof Page)
      return lookupNullableDispatcher<PageDispatcher>(result);
    return result;
  }

  async close(): Promise<void> {
    await this._context.close();
  }

  async crNewCDPSession(params: { page: PageDispatcher }): Promise<CDPSessionChannel> {
    const crBrowserContext = this._object as CRBrowserContext;
    return new CDPSessionDispatcher(this._scope, await crBrowserContext.newCDPSession(params.page._object));
  }
}
