interface TrajpackChromeTab {
  id?: number;
  url?: string;
  incognito: boolean;
}

declare const chrome: {
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<TrajpackChromeTab[]>;
  };
  scripting: {
    executeScript<Argument, Result>(details: {
      target: { tabId: number };
      world: "ISOLATED";
      func: (argument: Argument) => Result;
      args: [Argument];
    }): Promise<Array<{ result?: Result }>>;
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};
