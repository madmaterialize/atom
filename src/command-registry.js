'use strict'

/* global Event, CustomEvent */

const { Emitter, Disposable, CompositeDisposable } = require('event-kit')
const { calculateSpecificity, validateSelector } = require('clear-cut')
const _ = require('underscore-plus')

let SequenceCount = 0

// Public: Associates listener functions with commands in a
// context-sensitive way using CSS selectors. You can access a global instance of
// this class via `atom.commands`, and commands registered there will be
// presented in the command palette.
//
// The global command registry facilitates a style of event handling known as
// *event delegation* that was popularized by jQuery. Atom commands are expressed
// as custom DOM events that can be invoked on the currently focused element via
// a key binding or manually via the command palette. Rather than binding
// listeners for command events directly to DOM nodes, you instead register
// command event listeners globally on `atom.commands` and constrain them to
// specific kinds of elements with CSS selectors.
//
// Command names must follow the `namespace:action` pattern, where `namespace`
// will typically be the name of your package, and `action` describes the
// behavior of your command. If either part consists of multiple words, these
// must be separated by hyphens. E.g. `awesome-package:turn-it-up-to-eleven`.
// All words should be lowercased.
//
// As the event bubbles upward through the DOM, all registered event listeners
// with matching selectors are invoked in order of specificity. In the event of a
// specificity tie, the most recently registered listener is invoked first. This
// mirrors the "cascade" semantics of CSS. Event listeners are invoked in the
// context of the current DOM node, meaning `this` always points at
// `event.currentTarget`. As is normally the case with DOM events,
// `stopPropagation` and `stopImmediatePropagation` can be used to terminate the
// bubbling process and prevent invocation of additional listeners.
//
// ## Example
//
// Here is a command that inserts the current date in an editor:
//
// ```coffee
// atom.commands.add 'atom-text-editor',
//   'user:insert-date': (event) ->
//     editor = @getModel()
//     editor.insertText(new Date().toLocaleString())
// ```
module.exports = class CommandRegistry {
  constructor () {
    this.handleCommandEvent = this.handleCommandEvent.bind(this)
    this.rootNode = null
    this.clear()
  }

  clear () {
    this.registeredCommands = {}
    this.selectorBasedListenersByCommandName = {}
    this.inlineListenersByCommandName = {}
    this.emitter = new Emitter()
  }

  attach (rootNode) {
    this.rootNode = rootNode
    for (const command in this.selectorBasedListenersByCommandName) {
      this.commandRegistered(command)
    }

    for (const command in this.inlineListenersByCommandName) {
      this.commandRegistered(command)
    }
  }

  destroy () {
    for (const commandName in this.registeredCommands) {
      this.rootNode.removeEventListener(
        commandName,
        this.handleCommandEvent,
        true
      )
    }
  }

  // Public: Add one or more command listeners associated with a selector.
  //
  // ## Arguments: Registering One Command
  //
  // * `target` A {String} containing a CSS selector or a DOM element. If you
  //   pass a selector, the command will be globally associated with all matching
  //   elements. The `,` combinator is not currently supported. If you pass a
  //   DOM element, the command will be associated with just that element.
  // * `commandName` A {String} containing the name of a command you want to
  //   handle such as `user:insert-date`.
  // * `callback` A {Function} to call when the given command is invoked on an
  //   element matching the selector. It will be called with `this` referencing
  //   the matching DOM node.
  //   * `event` A standard DOM event instance. Call `stopPropagation` or
  //     `stopImmediatePropagation` to terminate bubbling early.
  //
  // ## Arguments: Registering Multiple Commands
  //
  // * `target` A {String} containing a CSS selector or a DOM element. If you
  //   pass a selector, the commands will be globally associated with all
  //   matching elements. The `,` combinator is not currently supported.
  //   If you pass a DOM element, the command will be associated with just that
  //   element.
  // * `commands` An {Object} mapping command names like `user:insert-date` to
  //   listener {Function}s.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // added command handler(s).
  add (target, commandName, listener, throwOnInvalidSelector = true) {
    if (typeof commandName === 'object') {
      const commands = commandName
      throwOnInvalidSelector = listener
      const disposable = new CompositeDisposable
      for (commandName in commands) {
        listener = commands[commandName]
        disposable.add(this.add(target, commandName, listener, throwOnInvalidSelector))
      }
      return disposable
    }

    if ((listener === null) || (listener === undefined)) {
      throw new Error('Cannot register a command with a null listener.')
    }

    if ((typeof listener !== 'function') && (typeof listener.handleEvent !== 'function')) {
      throw new Error('Listener must be a callback function or an object with a handleEvent method.')
    }

    if (typeof target === 'string') {
      if (throwOnInvalidSelector) {
        validateSelector(target)
      }
      return this.addSelectorBasedListener(target, commandName, listener)
    } else {
      return this.addInlineListener(target, commandName, listener)
    }
  }

  addSelectorBasedListener (selector, commandName, listener) {
    if (this.selectorBasedListenersByCommandName[commandName] == null) {
      this.selectorBasedListenersByCommandName[commandName] = []
    }
    const listenersForCommand = this.selectorBasedListenersByCommandName[commandName]
    const selectorListener = new SelectorBasedListener(selector, listener)
    listenersForCommand.push(selectorListener)

    this.commandRegistered(commandName)

    return new Disposable(() => {
      listenersForCommand.splice(listenersForCommand.indexOf(selectorListener), 1)
      if (listenersForCommand.length === 0) {
        delete this.selectorBasedListenersByCommandName[commandName]
      }
    })
  }

  addInlineListener (element, commandName, listener) {
    let listenersForElement
    if (this.inlineListenersByCommandName[commandName] == null) {
      this.inlineListenersByCommandName[commandName] = new WeakMap
    }

    const listenersForCommand = this.inlineListenersByCommandName[commandName]
    if (!(listenersForElement = listenersForCommand.get(element))) {
      listenersForElement = []
      listenersForCommand.set(element, listenersForElement)
    }
    const inlineListener = new InlineListener(listener)
    listenersForElement.push(inlineListener)

    this.commandRegistered(commandName)

    return new Disposable(() => {
      listenersForElement.splice(listenersForElement.indexOf(inlineListener), 1)
      if (listenersForElement.length === 0) {
        listenersForCommand.delete(element)
      }
    })
  }

  // Public: Find all registered commands matching a query.
  //
  // * `params` An {Object} containing one or more of the following keys:
  //   * `target` A DOM node that is the hypothetical target of a given command.
  //
  // Returns an {Array} of {Object}s containing the following keys:
  //  * `name` The name of the command. For example, `user:insert-date`.
  //  * `displayName` The display name of the command. For example,
  //    `User: Insert Date`.
  findCommands ({ target }) {
    const commandNames = new Set()
    const commands = []
    let currentTarget = target
    while (true) {
      let listeners
      for (const name in this.inlineListenersByCommandName) {
        listeners = this.inlineListenersByCommandName[name]
        if (listeners.has(currentTarget) && !commandNames.has(name)) {
          commandNames.add(name)
          commands.push(commandFromListener(name, listeners.get(currentTarget)))
        }
      }

      for (const commandName in this.selectorBasedListenersByCommandName) {
        listeners = this.selectorBasedListenersByCommandName[commandName]
        for (const listener of listeners) {
          if (
            currentTarget.webkitMatchesSelector &&
            currentTarget.webkitMatchesSelector(listener.selector)
          ) {
            if (!commandNames.has(commandName)) {
              commandNames.add(commandName)
              commands.push(commandFromListener(commandName, listener))
            }
          }
        }
      }

      if (currentTarget === window) {
        break
      }
      currentTarget = currentTarget.parentNode || window
    }

    return commands
  }

  // Public: Simulate the dispatch of a command on a DOM node.
  //
  // This can be useful for testing when you want to simulate the invocation of a
  // command on a detached DOM node. Otherwise, the DOM node in question needs to
  // be attached to the document so the event bubbles up to the root node to be
  // processed.
  //
  // * `target` The DOM node at which to start bubbling the command event.
  // * `commandName` {String} indicating the name of the command to dispatch.
  dispatch (target, commandName, detail) {
    const event = new CustomEvent(commandName, { bubbles: true, detail })
    Object.defineProperty(event, 'target', { value: target })
    return this.handleCommandEvent(event)
  }

  // Public: Invoke the given callback before dispatching a command event.
  //
  // * `callback` {Function} to be called before dispatching each command
  //   * `event` The Event that will be dispatched
  onWillDispatch (callback) {
    return this.emitter.on('will-dispatch', callback)
  }

  // Public: Invoke the given callback after dispatching a command event.
  //
  // * `callback` {Function} to be called after dispatching each command
  //   * `event` The Event that was dispatched
  onDidDispatch (callback) {
    return this.emitter.on('did-dispatch', callback)
  }

  getSnapshot () {
    const snapshot = {}
    for (const commandName in this.selectorBasedListenersByCommandName) {
      const listeners = this.selectorBasedListenersByCommandName[commandName]
      snapshot[commandName] = listeners.slice()
    }
    return snapshot
  }

  restoreSnapshot (snapshot) {
    this.selectorBasedListenersByCommandName = {}
    for (const commandName in snapshot) {
      const listeners = snapshot[commandName]
      this.selectorBasedListenersByCommandName[commandName] = listeners.slice()
    }
  }

  handleCommandEvent (event) {
    let propagationStopped = false
    let immediatePropagationStopped = false
    let matched = false
    let currentTarget = event.target

    const dispatchedEvent = new CustomEvent(event.type, {
      bubbles: true,
      detail: event.detail
    })
    Object.defineProperty(dispatchedEvent, 'eventPhase', {
      value: Event.BUBBLING_PHASE
    })
    Object.defineProperty(dispatchedEvent, 'currentTarget', {
      get () {
        return currentTarget
      }
    })
    Object.defineProperty(dispatchedEvent, 'target', { value: currentTarget })
    Object.defineProperty(dispatchedEvent, 'preventDefault', {
      value () {
        return event.preventDefault()
      }
    })
    Object.defineProperty(dispatchedEvent, 'stopPropagation', {
      value () {
        event.stopPropagation()
        propagationStopped = true
      }
    })
    Object.defineProperty(dispatchedEvent, 'stopImmediatePropagation', {
      value () {
        event.stopImmediatePropagation()
        propagationStopped = true
        immediatePropagationStopped = true
      }
    })
    Object.defineProperty(dispatchedEvent, 'abortKeyBinding', {
      value () {
        if (typeof event.abortKeyBinding === 'function') {
          event.abortKeyBinding()
        }
      }
    })

    for (const key of Object.keys(event)) {
      if (!(key in dispatchedEvent)) {
        dispatchedEvent[key] = event[key]
      }
    }

    this.emitter.emit('will-dispatch', dispatchedEvent)

    while (true) {
      const commandInlineListeners =
        this.inlineListenersByCommandName[event.type]
        ? this.inlineListenersByCommandName[event.type].get(currentTarget)
        : null
      let listeners = commandInlineListeners || []
      if (currentTarget.webkitMatchesSelector != null) {
        const selectorBasedListeners =
          (this.selectorBasedListenersByCommandName[event.type] || [])
            .filter(listener =>
              currentTarget.webkitMatchesSelector(listener.selector)
            )
            .sort((a, b) => a.compare(b))
        listeners = selectorBasedListeners.concat(listeners)
      }

      if (listeners.length > 0) {
        matched = true
      }

      // Call inline listeners first in reverse registration order,
      // and selector-based listeners by specificity and reverse
      // registration order.
      for (let i = listeners.length - 1; i >= 0; i--) {
        const listener = listeners[i]
        if (immediatePropagationStopped) {
          break
        }
        if (typeof listener.listener.handleEvent === 'function') {
          listener.listener.handleEvent(dispatchedEvent)
        } else {
          listener.listener.call(currentTarget, dispatchedEvent)
        }
      }

      if (currentTarget === window) {
        break
      }
      if (propagationStopped) {
        break
      }
      currentTarget = currentTarget.parentNode || window
    }

    this.emitter.emit('did-dispatch', dispatchedEvent)

    return matched
  }

  commandRegistered (commandName) {
    if (this.rootNode != null && !this.registeredCommands[commandName]) {
      this.rootNode.addEventListener(commandName, this.handleCommandEvent, true)
      return (this.registeredCommands[commandName] = true)
    }
  }
}

class SelectorBasedListener {
  constructor (selector, listener) {
    this.selector = selector
    this.listener = listener
    this.specificity = calculateSpecificity(this.selector)
    this.sequenceNumber = SequenceCount++
  }

  compare (other) {
    return (
      this.specificity - other.specificity ||
      this.sequenceNumber - other.sequenceNumber
    )
  }
}

class InlineListener {
  constructor (listener) {
    this.listener = listener
  }
}

function commandFromListener (name, listener) {
  return Object.assign(
    {displayName: _.humanizeEventName(name)},
    // don't allow those with a command derived from an object to invoke its
    // handler directly. rather, they should call ::dispatch a CustomEvent with
    // its `name` property
    _.omit(
      listener.listener,
      'handleEvent'
    ),
    // if listener.listener is a function callback, it may have a 'name' property
    // we want the command name ('foo:bar') in every case
    {name}
  )
}
