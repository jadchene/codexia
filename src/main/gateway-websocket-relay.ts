import { WebSocket, type RawData } from "ws";

interface QueuedMessage { data: RawData; isBinary: boolean }
type MessageTransform = (data: RawData, isBinary: boolean) => RawData | { messages: RawData[] } | false | null | undefined;

interface BridgeWebSocketsOptions {
  beforeDownstreamSend?: () => void;
  downstream: WebSocket;
  upstream: WebSocket;
  controller: AbortController;
  bufferHighWaterBytes: number;
  onDownstreamMessage?: MessageTransform;
  onUpstreamMessage?: MessageTransform;
  initialDownstreamMessages?: QueuedMessage[];
  takeInitialDownstreamMessages?: () => QueuedMessage[];
}

/**
 * Relays application messages between independently negotiated WebSockets.
 */
export function bridgeWebSockets(options: BridgeWebSocketsOptions): void {
  const {
    downstream,
    upstream,
    controller,
    bufferHighWaterBytes,
    onDownstreamMessage,
    onUpstreamMessage,
    initialDownstreamMessages = [],
    takeInitialDownstreamMessages
  } = options;
  let closing = false;

  const forward = (source: WebSocket, destination: WebSocket, transform?: MessageTransform) => (data: RawData, isBinary: boolean): void => {
    let replacement: ReturnType<MessageTransform>;
    try {
      replacement = transform?.(data, isBinary);
    } catch (error) {
      abortController(controller, "websocket_forward_error", error instanceof Error ? error.message : String(error));
      return;
    }
    if (replacement === false) return;
    const messages = replacement && typeof replacement === "object" && "messages" in replacement
      ? replacement.messages
      : [replacement ?? data];
    if (destination.readyState !== WebSocket.OPEN) return;
    for (const outgoingData of messages) {
      if (destination.bufferedAmount >= bufferHighWaterBytes) source.pause();
      destination.send(outgoingData, { binary: isBinary }, (error?: Error) => {
        if (source.isPaused && destination.bufferedAmount < bufferHighWaterBytes) source.resume();
        if (error) abortController(controller, "websocket_forward_error", error.message);
      });
    }
  };
  const forwardDownstream = forward(downstream, upstream, (data, isBinary) => {
    try { options.beforeDownstreamSend?.(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(JSON.stringify({ type: "error", error: { code: "upstream_ip_guard_blocked", message } }));
        downstream.close(1008, "upstream_ip_guard_blocked");
      }
      upstream.terminate();
      closing = true;
      return false;
    }
    return onDownstreamMessage?.(data, isBinary);
  });
  downstream.on("message", forwardDownstream);
  upstream.on("message", forward(upstream, downstream, onUpstreamMessage));
  const queuedMessages = typeof takeInitialDownstreamMessages === "function"
    ? takeInitialDownstreamMessages()
    : initialDownstreamMessages;
  for (const message of queuedMessages) {
    forwardDownstream(message.data, message.isBinary);
  }

  const closePeer = (peer: WebSocket) => (code: number, reason: Buffer): void => {
    if (closing) return;
    closing = true;
    if (peer.readyState === WebSocket.OPEN && code === 1005) peer.close();
    else if (peer.readyState === WebSocket.OPEN && isSendableCloseCode(code)) peer.close(code, reason);
    else if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
  };
  downstream.once("close", closePeer(upstream));
  upstream.once("close", closePeer(downstream));
  const terminate = (error: Error): void => abortController(controller, "websocket_transport_error", error.message);
  downstream.once("error", terminate);
  upstream.once("error", terminate);
  controller.signal.addEventListener("abort", () => {
    if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate();
    if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
  }, { once: true });
}

function isSendableCloseCode(code: number): boolean {
  return code === 1000
    || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999);
}

function abortController(controller: AbortController, code: string, message: string): void {
  if (controller.signal.aborted) return;
  const error = new Error(message);
  error.name = "AbortError";
  controller.abort(Object.assign(error, { code }));
}
