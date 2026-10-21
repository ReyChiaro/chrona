from chrona.infrastructure.i18n import msg
class DisabledRenderer:
    def __init__(self, settings):
        self.settings = settings

    def load(self, *, report=None):
        raise RuntimeError(msg('backend.adapters.providers.disabled.no-video-provider-is-configured-set-dw-provider-and'))

    def render(self, **kwargs):
        self.load()

    def unload(self):
        pass
