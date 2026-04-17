import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { createStudioDataSource } from './data/studio/createStudioDataSource';
import { StudioDataSourceProvider } from './data/studio/StudioDataSource';
import './styles.css';

const studioDataSource = createStudioDataSource(import.meta.env as Record<string, string | undefined>);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <StudioDataSourceProvider value={studioDataSource}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StudioDataSourceProvider>
  </React.StrictMode>
);
