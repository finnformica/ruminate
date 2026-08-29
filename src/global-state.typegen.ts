// This file was automatically generated. Edits will be overwritten

export interface Typegen0 {
  "@@xstate/typegen": true
  internalEvents: {
    "done.invoke.global.resolvingUser:invocation[0]": {
      type: "done.invoke.global.resolvingUser:invocation[0]"
      data: unknown
      __tip: "See the XState TS docs to learn how to strongly type this."
    }
    "error.platform.global.resolvingUser:invocation[0]": {
      type: "error.platform.global.resolvingUser:invocation[0]"
      data: unknown
    }
    "xstate.init": { type: "xstate.init" }
    "xstate.stop": { type: "xstate.stop" }
  }
  invokeSrcNameMap: {
    resolveUser: "done.invoke.global.resolvingUser:invocation[0]"
  }
  missingImplementations: {
    actions: never
    delays: never
    guards: never
    services: never
  }
  eventsCausingActions: {
    clearGitHubUser: "SIGN_OUT" | "error.platform.global.resolvingUser:invocation[0]"
    clearGitHubUserLocalStorage: "SIGN_OUT" | "error.platform.global.resolvingUser:invocation[0]"
    clearMarkdownFiles: "SIGN_IN" | "xstate.stop"
    setGitHubUser: "SIGN_IN" | "done.invoke.global.resolvingUser:invocation[0]"
    setGitHubUserLocalStorage: "SIGN_IN" | "done.invoke.global.resolvingUser:invocation[0]"
    setSampleMarkdownFiles: "SIGN_OUT" | "error.platform.global.resolvingUser:invocation[0]"
  }
  eventsCausingDelays: {}
  eventsCausingGuards: {}
  eventsCausingServices: {
    resolveUser: "xstate.init"
  }
  matchesStates: "resolvingUser" | "signedIn" | "signedOut"
  tags: never
}
