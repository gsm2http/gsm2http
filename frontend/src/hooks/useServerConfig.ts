import { useEffect, useState } from 'react';
import { errorMessage, getConfig } from '../api/client';
import type { ServerConfig } from '../api/types';

export function useServerConfig(onError: (message: string) => void) {
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err: unknown) => onError(`Failed to load config: ${errorMessage(err)}`));
  }, [onError]);

  return { config };
}
