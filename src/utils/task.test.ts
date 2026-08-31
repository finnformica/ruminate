import { fromMarkdown } from "mdast-util-from-markdown"
import type { ListItem } from "mdast-util-from-markdown/lib"
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item"
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item"
import { visit } from "unist-util-visit"
import { describe, expect, test } from "vitest"
import { priority, priorityFromMarkdown } from "../remark-plugins/priority"
import { tag, tagFromMarkdown } from "../remark-plugins/tag"
import {
  deleteTask,
  getTaskContent,
  getTaskPriority,
  prioritizeTask,
  removePriorityFromTaskText,
  getTaskTags,
  updateTaskCompletion,
  updateTaskText,
} from "./task"

function parseMarkdown(content: string) {
  const extensions = [gfmTaskListItem(), tag(), priority()]
  const mdastExtensions = [gfmTaskListItemFromMarkdown(), tagFromMarkdown(), priorityFromMarkdown()]

  return fromMarkdown(
    content,
    // @ts-ignore TODO: Fix types
    { extensions, mdastExtensions },
  )
}

function findFirstListItem(root: ReturnType<typeof parseMarkdown>): ListItem | null {
  let listItem: ListItem | null = null
  visit(root, (node) => {
    if (node.type === "listItem" && !listItem) {
      listItem = node
    }
  })
  return listItem
}

describe("getTaskContent", () => {
  test("extracts task text from a simple task", () => {
    const root = parseMarkdown("- [ ] Do laundry")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskContent(listItem, "- [ ] Do laundry")
      expect(result.text).toBe("Do laundry")
    }
  })

  test("extracts task text from a completed task", () => {
    const root = parseMarkdown("- [x] Complete project")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskContent(listItem, "- [x] Complete project")
      expect(result.text).toBe("Complete project")
    }
  })

  test("extracts task text with literal [[...]] text", () => {
    const root = parseMarkdown("- [ ] Review [[project-alpha]] plan")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskContent(listItem, "- [ ] Review [[project-alpha]] plan")
      expect(result.text).toBe("Review [[project-alpha]] plan")
    }
  })

  test("extracts task text with tags", () => {
    const root = parseMarkdown("- [ ] Task with #tag")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskContent(listItem, "- [ ] Task with #tag")
      expect(result.text).toBe("Task with #tag")
    }
  })

  test("handles tasks with extra whitespace", () => {
    const root = parseMarkdown("- [ ]   Task with spaces")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskContent(listItem, "- [ ]   Task with spaces")
      expect(result.text).toBe("Task with spaces")
    }
  })
})

describe("getTaskTags", () => {
  test("extracts tags from task content", () => {
    const root = parseMarkdown("- [ ] Task with #tag")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskTags(listItem)
      expect(result).toEqual(["tag"])
    }
  })

  test("extracts multiple tags", () => {
    const root = parseMarkdown("- [ ] Task with #tag1 and #tag2")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskTags(listItem)
      expect(result.sort()).toEqual(["tag1", "tag2"])
    }
  })

  test("extracts nested tags with parent expansion", () => {
    const root = parseMarkdown("- [ ] Task with #parent/child")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskTags(listItem)
      expect(result.sort()).toEqual(["parent", "parent/child"])
    }
  })

  test("returns empty array when no tags", () => {
    const root = parseMarkdown("- [ ] Simple task")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskTags(listItem)
      expect(result).toEqual([])
    }
  })

  test("deduplicates tags", () => {
    const root = parseMarkdown("- [ ] Task with #tag and #tag")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskTags(listItem)
      expect(result).toEqual(["tag"])
    }
  })
})

describe("updateTaskCompletion", () => {
  test("marks incomplete task as completed", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Do laundry")
  })

  test("marks completed task as incomplete", () => {
    const content = "- [x] Do laundry"
    const task = {
      completed: true,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: false })
    expect(result).toBe("- [ ] Do laundry")
  })

  test("handles uppercase X in checkbox", () => {
    const content = "- [X] Do laundry"
    const task = {
      completed: true,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: false })
    expect(result).toBe("- [ ] Do laundry")
  })

  test("preserves extra spaces between checkbox and text", () => {
    const content = "- [ ]   Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x]   Do laundry")
  })

  test("handles tasks with literal [[...]] text", () => {
    const content = "- [ ] Review [[project-alpha]] plan"
    const task = {
      completed: false,
      text: "Review [[project-alpha]] plan",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Review [[project-alpha]] plan")
  })

  test("handles tasks with tags", () => {
    const content = "- [ ] Task with #tag"
    const task = {
      completed: false,
      text: "Task with #tag",
      tags: ["tag"],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Task with #tag")
  })

  test("handles tasks with date links", () => {
    const content = "- [ ] Task due [[2024-12-31]]"
    const task = {
      completed: false,
      text: "Task due [[2024-12-31]]",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Task due [[2024-12-31]]")
  })

  test("handles tasks with special regex characters", () => {
    const content = "- [ ] Task with (parentheses) and [brackets]"
    const task = {
      completed: false,
      text: "Task with (parentheses) and [brackets]",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Task with (parentheses) and [brackets]")
  })

  test("returns original content if task already in desired state", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: false })
    expect(result).toBe("- [ ] Do laundry")
  })

  test("updates first task when multiple exist", () => {
    const content = "- [ ] First task\n- [ ] Second task"
    const task = {
      completed: false,
      text: "First task",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] First task\n- [ ] Second task")
  })

  test("updates task in the middle of multiline content", () => {
    const content = "- [ ] First task\n- [ ] Middle task\n- [ ] Last task"
    const task = {
      completed: false,
      text: "Middle task",
      tags: [],
      priority: null,
      startOffset: 17, // Position of "- [ ] Middle task"
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [ ] First task\n- [x] Middle task\n- [ ] Last task")
  })

  test("handles tasks with markdown formatting", () => {
    const content = "- [ ] Publish **release notes** [[2024-11-11]]"
    const task = {
      completed: false,
      text: "Publish **release notes** [[2024-11-11]]",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe("- [x] Publish **release notes** [[2024-11-11]]")
  })

  test("updates correct duplicate task using position", () => {
    const content = "- [ ] Buy milk\n- [ ] Buy milk"
    const secondTask = {
      completed: false,
      text: "Buy milk",
      tags: [],
      priority: null,
      startOffset: 15, // Position of second "- [ ] Buy milk"
    }

    const result = updateTaskCompletion({ content, task: secondTask, completed: true })
    expect(result).toBe("- [ ] Buy milk\n- [x] Buy milk")
  })

  test("updates first of duplicate tasks correctly", () => {
    const content = "- [ ] Buy milk\n- [ ] Buy milk"
    const firstTask = {
      completed: false,
      text: "Buy milk",
      tags: [],
      priority: null,
      startOffset: 0, // Position of first "- [ ] Buy milk"
    }

    const result = updateTaskCompletion({ content, task: firstTask, completed: true })
    expect(result).toBe("- [x] Buy milk\n- [ ] Buy milk")
  })

  test("updates task with frontmatter offset correctly", () => {
    const content = `---
title: My Note
---

- [ ] Task after frontmatter`
    const task = {
      completed: false,
      text: "Task after frontmatter",
      tags: [],
      priority: null,
      startOffset: 24, // "---\ntitle: My Note\n---\n\n" = 24 chars
    }

    const result = updateTaskCompletion({ content, task, completed: true })
    expect(result).toBe(`---
title: My Note
---

- [x] Task after frontmatter`)
  })
})

describe("updateTaskText", () => {
  test("updates task text", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "Do dishes" })
    expect(result).toBe("- [ ] Do dishes")
  })

  test("preserves checkbox state when updating text", () => {
    const content = "- [x] Do laundry"
    const task = {
      completed: true,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "Do dishes" })
    expect(result).toBe("- [x] Do dishes")
  })

  test("handles empty text", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "" })
    expect(result).toBe("- [ ]")
  })

  test("handles whitespace-only text", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "   " })
    expect(result).toBe("- [ ]")
  })

  test("trims whitespace from new text", () => {
    const content = "- [ ] Do laundry"
    const task = {
      completed: false,
      text: "Do laundry",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "  Do dishes  " })
    expect(result).toBe("- [ ] Do dishes")
  })

  test("updates task in multiline content", () => {
    const content = "- [ ] First task\n- [ ] Second task\n- [ ] Third task"
    const task = {
      completed: false,
      text: "Second task",
      tags: [],
      priority: null,
      startOffset: 17,
    }

    const result = updateTaskText({ content, task, text: "Updated task" })
    expect(result).toBe("- [ ] First task\n- [ ] Updated task\n- [ ] Third task")
  })

  test("updates last task in content", () => {
    const content = "- [ ] First task\n- [ ] Last task"
    const task = {
      completed: false,
      text: "Last task",
      tags: [],
      priority: null,
      startOffset: 17,
    }

    const result = updateTaskText({ content, task, text: "Updated last" })
    expect(result).toBe("- [ ] First task\n- [ ] Updated last")
  })

  test("handles task with literal [[...]] text", () => {
    const content = "- [ ] Review [[project-alpha]]"
    const task = {
      completed: false,
      text: "Review [[project-alpha]]",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "Review [[project-beta]]" })
    expect(result).toBe("- [ ] Review [[project-beta]]")
  })

  test("handles task with date links", () => {
    const content = "- [ ] Task due [[2024-12-31]]"
    const task = {
      completed: false,
      text: "Task due [[2024-12-31]]",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = updateTaskText({ content, task, text: "Task due [[2025-01-01]]" })
    expect(result).toBe("- [ ] Task due [[2025-01-01]]")
  })

  test("updates correct duplicate task using position", () => {
    const content = "- [ ] Buy milk\n- [ ] Buy milk"
    const secondTask = {
      completed: false,
      text: "Buy milk",
      tags: [],
      priority: null,
      startOffset: 15,
    }

    const result = updateTaskText({ content, task: secondTask, text: "Buy eggs" })
    expect(result).toBe("- [ ] Buy milk\n- [ ] Buy eggs")
  })

  test("updates task with frontmatter offset correctly", () => {
    const content = `---
title: My Note
---

- [ ] Task after frontmatter`
    const task = {
      completed: false,
      text: "Task after frontmatter",
      tags: [],
      priority: null,
      startOffset: 24,
    }

    const result = updateTaskText({ content, task, text: "Updated task" })
    expect(result).toBe(`---
title: My Note
---

- [ ] Updated task`)
  })
})

describe("getTaskPriority", () => {
  test("extracts priority 1 from task", () => {
    const root = parseMarkdown("- [ ] !!1 Urgent task")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(1)
    }
  })

  test("extracts priority 2 from task", () => {
    const root = parseMarkdown("- [ ] !!2 Medium task")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(2)
    }
  })

  test("extracts priority 3 from task", () => {
    const root = parseMarkdown("- [ ] !!3 Low task")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(3)
    }
  })

  test("returns null when no priority", () => {
    const root = parseMarkdown("- [ ] Simple task")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBeNull()
    }
  })

  test("last priority wins when multiple", () => {
    const root = parseMarkdown("- [ ] !!1 first !!2 second !!3 third")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(3)
    }
  })

  test("handles priority in middle of task", () => {
    const root = parseMarkdown("- [ ] Task with !!2 priority here")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(2)
    }
  })

  test("handles priority at end of task", () => {
    const root = parseMarkdown("- [ ] Task at end !!1")
    const listItem = findFirstListItem(root)
    expect(listItem).not.toBeNull()

    if (listItem) {
      const result = getTaskPriority(listItem)
      expect(result).toBe(1)
    }
  })
})

describe("removePriorityFromTaskText", () => {
  test("removes priority from start of text", () => {
    expect(removePriorityFromTaskText("!!1 Task text", 1)).toBe("Task text")
  })

  test("removes priority from end of text", () => {
    expect(removePriorityFromTaskText("Task text !!2", 2)).toBe("Task text")
  })

  test("removes priority from middle of text", () => {
    expect(removePriorityFromTaskText("Task !!3 text", 3)).toBe("Task text")
  })

  test("normalizes multiple spaces after removal", () => {
    expect(removePriorityFromTaskText("Task  !!1  text", 1)).toBe("Task text")
  })

  test("does not remove different priority level", () => {
    expect(removePriorityFromTaskText("!!1 Task text", 2)).toBe("!!1 Task text")
  })

  test("removes all occurrences of the same priority", () => {
    expect(removePriorityFromTaskText("!!1 Task !!1 text", 1)).toBe("Task text")
  })
})

describe("prioritizeTask", () => {
  test("adds priority to task with no existing priority (prepends)", () => {
    const content = "- [ ] Task without priority"
    const task = {
      completed: false,
      text: "Task without priority",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 1 })
    expect(result).toBe("- [ ] !!1 Task without priority")
  })

  test("changes priority from one level to another", () => {
    const content = "- [ ] !!1 Urgent task"
    const task = {
      completed: false,
      text: "!!1 Urgent task",
      tags: [],
      priority: 1 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 2 })
    expect(result).toBe("- [ ] !!2 Urgent task")
  })

  test("removes priority when setting to null", () => {
    const content = "- [ ] !!1 Urgent task"
    const task = {
      completed: false,
      text: "!!1 Urgent task",
      tags: [],
      priority: 1 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: null })
    expect(result).toBe("- [ ] Urgent task")
  })

  test("returns unchanged when priority is the same", () => {
    const content = "- [ ] !!1 Urgent task"
    const task = {
      completed: false,
      text: "!!1 Urgent task",
      tags: [],
      priority: 1 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 1 })
    expect(result).toBe("- [ ] !!1 Urgent task")
  })

  test("returns unchanged when setting null to null", () => {
    const content = "- [ ] Task without priority"
    const task = {
      completed: false,
      text: "Task without priority",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: null })
    expect(result).toBe("- [ ] Task without priority")
  })

  test("replaces priority at end of task text in place", () => {
    const content = "- [ ] Task at end !!2"
    const task = {
      completed: false,
      text: "Task at end !!2",
      tags: [],
      priority: 2 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 1 })
    expect(result).toBe("- [ ] Task at end !!1")
  })

  test("replaces priority in middle of task text in place", () => {
    const content = "- [ ] Task !!3 in middle"
    const task = {
      completed: false,
      text: "Task !!3 in middle",
      tags: [],
      priority: 3 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 1 })
    expect(result).toBe("- [ ] Task !!1 in middle")
  })

  test("handles task with both priority and date", () => {
    const content = "- [ ] !!1 Task [[2024-01-01]]"
    const task = {
      completed: false,
      text: "!!1 Task [[2024-01-01]]",
      tags: [],
      priority: 1 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: 2 })
    expect(result).toBe("- [ ] !!2 Task [[2024-01-01]]")
  })

  test("handles task with priority, date, and tags", () => {
    const content = "- [ ] !!2 Task #urgent [[2024-01-01]]"
    const task = {
      completed: false,
      text: "!!2 Task #urgent [[2024-01-01]]",
      tags: ["urgent"],
      priority: 2 as const,
      startOffset: 0,
    }

    const result = prioritizeTask({ content, task, priority: null })
    expect(result).toBe("- [ ] Task #urgent [[2024-01-01]]")
  })

  test("handles duplicate tasks using position", () => {
    const content = "- [ ] !!1 Task\n- [ ] !!1 Task"
    const secondTask = {
      completed: false,
      text: "!!1 Task",
      tags: [],
      priority: 1 as const,
      startOffset: 15,
    }

    const result = prioritizeTask({ content, task: secondTask, priority: 2 })
    expect(result).toBe("- [ ] !!1 Task\n- [ ] !!2 Task")
  })

  test("handles task with frontmatter offset", () => {
    const content = `---
title: My Note
---

- [ ] !!1 Task after frontmatter`
    const task = {
      completed: false,
      text: "!!1 Task after frontmatter",
      tags: [],
      priority: 1 as const,
      startOffset: 24,
    }

    const result = prioritizeTask({ content, task, priority: 3 })
    expect(result).toBe(`---
title: My Note
---

- [ ] !!3 Task after frontmatter`)
  })
})

describe("deleteTask", () => {
  test("deletes a simple task", () => {
    const content = "- [ ] Task to delete"
    const task = {
      completed: false,
      text: "Task to delete",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("")
  })

  test("deletes task and preserves surrounding content", () => {
    const content = "Some text\n- [ ] Task to delete\nMore text"
    const task = {
      completed: false,
      text: "Task to delete",
      tags: [],
      priority: null,
      startOffset: 10,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("Some text\nMore text")
  })

  test("deletes task at start of content", () => {
    const content = "- [ ] First task\n- [ ] Second task"
    const task = {
      completed: false,
      text: "First task",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] Second task")
  })

  test("deletes task at end of content", () => {
    const content = "- [ ] First task\n- [ ] Second task"
    const task = {
      completed: false,
      text: "Second task",
      tags: [],
      priority: null,
      startOffset: 17,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] First task\n")
  })

  test("deletes task with nested tasks", () => {
    const content = "- [ ] Parent task\n  - [ ] Nested task\n- [ ] Sibling task"
    const task = {
      completed: false,
      text: "Parent task",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] Sibling task")
  })

  test("deletes task with multiple levels of nesting", () => {
    const content = "- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n- [ ] Sibling"
    const task = {
      completed: false,
      text: "Parent",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] Sibling")
  })

  test("deletes only nested task, not parent", () => {
    const content = "- [ ] Parent task\n  - [ ] Nested task\n- [ ] Sibling task"
    const task = {
      completed: false,
      text: "Nested task",
      tags: [],
      priority: null,
      startOffset: 20,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] Parent task\n- [ ] Sibling task")
  })

  test("deletes correct task when duplicates exist using position", () => {
    const content = "- [ ] Same task\n- [ ] Same task"
    const secondTask = {
      completed: false,
      text: "Same task",
      tags: [],
      priority: null,
      startOffset: 16,
    }

    const result = deleteTask({ content, task: secondTask })
    expect(result).toBe("- [ ] Same task\n")
  })

  test("deletes task with no trailing newline", () => {
    const content = "- [ ] Only task"
    const task = {
      completed: false,
      text: "Only task",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("")
  })

  test("deletes completed task", () => {
    const content = "- [x] Completed task\n- [ ] Incomplete task"
    const task = {
      completed: true,
      text: "Completed task",
      tags: [],
      priority: null,
      startOffset: 0,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe("- [ ] Incomplete task")
  })

  test("handles task with frontmatter", () => {
    const content = `---
title: My Note
---

- [ ] Task after frontmatter`
    const task = {
      completed: false,
      text: "Task after frontmatter",
      tags: [],
      priority: null,
      startOffset: 24,
    }

    const result = deleteTask({ content, task })
    expect(result).toBe(`---
title: My Note
---

`)
  })
})
