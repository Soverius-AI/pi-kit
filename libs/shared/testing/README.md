# @pi-kit/testing

Test doubles shared by the specs of several domains (`scope:shared`, `type:util`): thread and graph-row fixtures and `fakeThreads`,
the part of `ThreadsStore` that other stores read. Only specs import it; it is not part of any build (it uses vitest's `vi`, which
the `tsconfig.spec.json` of the importing project provides).
