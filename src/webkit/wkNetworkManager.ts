/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WKTargetSession } from './wkConnection';
import { Page } from '../page';
import { helper, RegisteredListener } from '../helper';
import { Protocol } from './protocol';
import * as network from '../network';
import * as frames from '../frames';

export class WKNetworkManager {
  private _session: WKTargetSession;
  private _page: Page;
  private _requestIdToRequest = new Map<string, InterceptableRequest>();
  private _attemptedAuthentications = new Set<string>();
  private _userCacheDisabled = false;
  private _sessionListeners: RegisteredListener[] = [];

  constructor(page: Page) {
    this._page = page;
  }

  setSession(session: WKTargetSession) {
    helper.removeEventListeners(this._sessionListeners);
    this._session = session;
    this._sessionListeners = [
      helper.addEventListener(this._session, 'Network.requestWillBeSent', this._onRequestWillBeSent.bind(this)),
      helper.addEventListener(this._session, 'Network.responseReceived', this._onResponseReceived.bind(this)),
      helper.addEventListener(this._session, 'Network.loadingFinished', this._onLoadingFinished.bind(this)),
      helper.addEventListener(this._session, 'Network.loadingFailed', this._onLoadingFailed.bind(this)),
    ];
  }

  async initializeSession(session: WKTargetSession) {
    await session.send('Network.enable');
  }

  dispose() {
    helper.removeEventListeners(this._sessionListeners);
  }

  async setCacheEnabled(enabled: boolean) {
    this._userCacheDisabled = !enabled;
    await this._updateProtocolCacheDisabled();
  }

  async _updateProtocolCacheDisabled() {
    await this._session.send('Network.setResourceCachingDisabled', {
      disabled: this._userCacheDisabled
    });
  }

  _onRequestWillBeSent(event: Protocol.Network.requestWillBeSentPayload) {
    let redirectChain: network.Request[] = [];
    if (event.redirectResponse) {
      const request = this._requestIdToRequest.get(event.requestId);
      // If we connect late to the target, we could have missed the requestWillBeSent event.
      if (request) {
        this._handleRequestRedirect(request, event.redirectResponse);
        redirectChain = request.request._redirectChain;
      }
    }
    const frame = this._page._frameManager.frame(event.frameId);
    // TODO(einbinder) this will fail if we are an XHR document request
    const isNavigationRequest = event.type === 'Document';
    const documentId = isNavigationRequest ? this._session._sessionId + '::' + event.loaderId : undefined;
    const request = new InterceptableRequest(frame, undefined, event, redirectChain, documentId);
    this._requestIdToRequest.set(event.requestId, request);
    this._page._frameManager.requestStarted(request.request);
  }

  _createResponse(request: InterceptableRequest, responsePayload: Protocol.Network.Response): network.Response {
    const remoteAddress: network.RemoteAddress = { ip: '', port: 0 };
    const getResponseBody = async () => {
      const response = await this._session.send('Network.getResponseBody', { requestId: request._requestId });
      return Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
    };
    return new network.Response(request.request, responsePayload.status, responsePayload.statusText, headersObject(responsePayload.headers), remoteAddress, getResponseBody);
  }

  _handleRequestRedirect(request: InterceptableRequest, responsePayload: Protocol.Network.Response) {
    const response = this._createResponse(request, responsePayload);
    request.request._redirectChain.push(request.request);
    response._requestFinished(new Error('Response body is unavailable for redirect responses'));
    this._requestIdToRequest.delete(request._requestId);
    this._attemptedAuthentications.delete(request._interceptionId);
    this._page._frameManager.requestReceivedResponse(response);
    this._page._frameManager.requestFinished(request.request);
  }

  _onResponseReceived(event: Protocol.Network.responseReceivedPayload) {
    const request = this._requestIdToRequest.get(event.requestId);
    // FileUpload sends a response without a matching request.
    if (!request)
      return;
    const response = this._createResponse(request, event.response);
    this._page._frameManager.requestReceivedResponse(response);
  }

  _onLoadingFinished(event: Protocol.Network.loadingFinishedPayload) {
    const request = this._requestIdToRequest.get(event.requestId);
    // For certain requestIds we never receive requestWillBeSent event.
    // @see https://crbug.com/750469
    if (!request)
      return;

    // Under certain conditions we never get the Network.responseReceived
    // event from protocol. @see https://crbug.com/883475
    if (request.request.response())
      request.request.response()._requestFinished();
    this._requestIdToRequest.delete(request._requestId);
    this._attemptedAuthentications.delete(request._interceptionId);
    this._page._frameManager.requestFinished(request.request);
  }

  _onLoadingFailed(event: Protocol.Network.loadingFailedPayload) {
    const request = this._requestIdToRequest.get(event.requestId);
    // For certain requestIds we never receive requestWillBeSent event.
    // @see https://crbug.com/750469
    if (!request)
      return;
    const response = request.request.response();
    if (response)
      response._requestFinished();
    this._requestIdToRequest.delete(request._requestId);
    this._attemptedAuthentications.delete(request._interceptionId);
    request.request._setFailureText(event.errorText);
    this._page._frameManager.requestFailed(request.request, event.errorText.includes('cancelled'));
  }
}

const interceptableRequestSymbol = Symbol('interceptableRequest');

export function toInterceptableRequest(request: network.Request): InterceptableRequest {
  return (request as any)[interceptableRequestSymbol];
}

class InterceptableRequest {
  readonly request: network.Request;
  _requestId: string;
  _interceptionId: string;
  _documentId: string | undefined;

  constructor(frame: frames.Frame | null, interceptionId: string, event: Protocol.Network.requestWillBeSentPayload, redirectChain: network.Request[], documentId: string | undefined) {
    this._requestId = event.requestId;
    this._interceptionId = interceptionId;
    this._documentId = documentId;
    this.request = new network.Request(frame, redirectChain, documentId, event.request.url,
        event.type ? event.type.toLowerCase() : 'Unknown', event.request.method, event.request.postData, headersObject(event.request.headers));
    (this.request as any)[interceptableRequestSymbol] = this;
  }
}

function headersObject(headers: Protocol.Network.Headers): network.Headers {
  const result: network.Headers = {};
  for (const key of Object.keys(headers))
    result[key.toLowerCase()] = headers[key];
  return result;
}