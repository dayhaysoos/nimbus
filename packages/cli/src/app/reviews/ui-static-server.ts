import { createServer, type Server } from 'http';
import { createReviewEventsFanout } from './ui-events-fanout.js';
import { handleStaticRequest } from './ui-static.js';
import type { UiServerSession } from './ui-server.js';

const LOCAL_HOST = '127.0.0.1';

async function startStaticServer(options: {
  distDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<Server> {
  const reviewEventsFanout = createReviewEventsFanout({
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
  });

  const server = createServer((request, response) => {
    void handleStaticRequest(request, response, {
      distDir: options.distDir,
      reviewEventsFanout,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
    });
  });
  server.on('close', () => {
    void reviewEventsFanout.close();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once('error', onError);
    server.listen(options.port, LOCAL_HOST, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  return server;
}

export async function startStaticServerSession(options: {
  routePath: string;
  distDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<UiServerSession> {
  const appUrl = `http://${LOCAL_HOST}:${options.port}${options.routePath}`;
  const server = await startStaticServer({
    distDir: options.distDir,
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
    port: options.port,
  });

  return {
    appUrl,
    uiMode: 'static',
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
    waitForExit: async () => {
      await new Promise<void>((_resolve, rejectWait) => {
        if (!server.listening) {
          rejectWait(new Error('Report UI server stopped unexpectedly.'));
          return;
        }
        const onClose = () => {
          server.off('error', onError);
          rejectWait(new Error('Report UI server stopped unexpectedly.'));
        };
        const onError = (error: Error) => {
          server.off('close', onClose);
          rejectWait(error);
        };
        server.once('close', onClose);
        server.once('error', onError);
      });
    },
  };
}
