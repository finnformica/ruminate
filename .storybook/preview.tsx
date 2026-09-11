import { Tooltip } from "@base-ui/react/tooltip"
import React from "react"
import "../src/styles/index.css"

export const parameters = {
  actions: { argTypesRegex: "^on[A-Z].*" },
  controls: {
    matchers: {
      color: /(background|color)$/i,
      date: /Date$/,
    },
  },
}

// The colour scheme, as the app stamps it on <html> (src/hooks/color-scheme.ts):
// the stylesheets key off `data-theme`, so a story is dark only when told.
export const globalTypes = {
  theme: {
    toolbar: {
      icon: "mirror",
      items: ["light", "dark"],
      dynamicTitle: true,
    },
  },
}

export const initialGlobals = {
  theme: "light",
}

export const decorators = [
  (Story, context) => {
    React.useEffect(() => {
      document.documentElement.setAttribute("data-theme", context.globals.theme || "light")
    }, [context.globals.theme])

    return (
      <Tooltip.Provider>
        <Story />
      </Tooltip.Provider>
    )
  },
]
