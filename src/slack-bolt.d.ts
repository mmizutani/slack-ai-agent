declare module "@slack/bolt" {
  // Minimal stub for the parts of Bolt used in this codebase.
  // Extend as needed when additional members are referenced.
  export class App {
    constructor(...args: any[]);

    // Event registration helpers
    message(...args: any[]): any;
    event(eventName: string, ...args: any[]): any;
    action(actionId: string, ...args: any[]): any;

    // Web client
    client: any;

    // Start the bolt app (used in index.ts)
    start(...args: any[]): Promise<void>;

    // Disconnect. Used to tear down a verification host process cleanly.
    stop(...args: any[]): Promise<void>;

    // Deliver a receiver payload straight into the middleware chain.
    //
    // Public in Bolt (see node_modules/@slack/bolt/dist/App.d.ts). The live
    // verification harness needs it because Slack exposes no Web API that
    // originates a Block Kit button click, so the only way to exercise the
    // approval path end to end is to hand Bolt the payload Slack would have
    // delivered.
    processEvent(event: {
      body: any;
      ack: (response?: any) => Promise<any>;
      retryNum?: number;
      retryReason?: string;
    }): Promise<void>;
  }
}
