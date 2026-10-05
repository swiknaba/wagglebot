# Reference Agent Setup

This is a runnable company configuration for Wagglebot-supported worker harnesses.
It is separate from `test-app`, which remains the regenerated offline fixture.

Connect it with the first published Wagglebot release that supports company
subdirectories (`0.3.2` or later):

```sh
wagglebot connect https://github.com/swiknaba/wagglebot.git examples/reference-setup
wagglebot update --wagglebot
```

Run the commands in a disposable `HOME` when evaluating the setup. The configured
Superpowers source provides shared skills to supported workers. The initial approved
workflows are `brainstorming` and `writing-plans`; other packaged skills remain optional.

Some runtime-specific agents consume this library through their own integration rather
than Wagglebot provisioning. Their local role instructions and persistent state remain
configured independently of this reusable worker setup.

The reference setup currently pins published Wagglebot `0.3.3`. Its release
workflow verifies the staged artifact, the published registry package, and this
reference provisioning path before the release is considered ready.
