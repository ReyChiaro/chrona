"""Adapt a local reference-video model to the common segmented renderer contract."""
from chrona.infrastructure.i18n import msg
import importlib
import json
import math
import hashlib

from chrona.rendering.harness import prompt_defaults
from chrona.infrastructure.resources import resource


class LocalReferenceRenderer:
    def __init__(self, settings):
        self.settings = settings
        self.profile = json.loads(settings.profile_path.read_text())
        module, name = settings.provider.split(':')
        self.renderer = getattr(importlib.import_module(module), name)(settings)

    def model_identity(self):
        root = self.settings.model_path
        files = sorted(path for path in root.rglob('*') if path.is_file()) if root and root.is_dir() else []
        # File stamps are a conservative change detector; publish immutable revisions for durable model identity.
        evidence = [(path.relative_to(root).as_posix(), path.stat().st_size, path.stat().st_mtime_ns) for path in files]
        manifests = [(path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()) for path in files if path.suffix == '.json']
        fingerprint = hashlib.sha256(json.dumps({'provider': self.settings.provider, 'revision': self.settings.model_revision,
            'files': evidence, 'manifests': manifests, 'profile': self.profile}, sort_keys=True).encode()).hexdigest()
        return {'revision': self.settings.model_revision, 'fingerprint': fingerprint}

    def display_profile(self):
        # Legacy profile bytes participate in model identity. Keep those labels
        # frozen and apply the shared catalog only to the capability read model.
        if self.settings.profile_path.resolve() != resource('configs/render-profile.json').resolve():
            return self.profile
        keys = json.loads(resource('configs/render-profile.i18n.json').read_text())
        result = {**self.profile, 'parameters': [dict(field) for field in self.profile['parameters']]}
        for field in ('label', 'samplingNote'):
            result[field] = msg(keys[field])
            result[field + 'Key'] = keys[field]
        for field in result['parameters']:
            key = keys['parameters'].get(field['key'])
            if key:
                field.update(label=msg(key), labelKey=key)
        return result

    def capabilities(self):
        display = self.display_profile()
        limits = self.profile['reference']
        fps, multiple, offset = limits['fps'], limits['frameMultiple'], limits['frameOffset']
        minimum = math.ceil((limits['minDuration'] * fps - offset) / multiple) * multiple + offset
        maximum = math.floor((limits['maxDuration'] * fps - offset) / multiple) * multiple + offset
        available = self.renderer.available() if hasattr(self.renderer, 'available') else not self.settings.provider.endswith(':DisabledRenderer')
        adapters = {'adapters': self.renderer.adapter_catalog.capabilities()} if hasattr(self.renderer, 'adapter_catalog') else {}
        identity = self.model_identity()
        return {'label': display['label'], 'enabled': available, 'modelIdentity': identity,
            **{key: display[key] for key in ('labelKey', 'samplingNoteKey') if key in display},
            'error': '' if available else msg('backend.adapters.providers.local-reference.the-local-model-directory-is-missing-or-incomplete-check'),
            'profile': self.settings.provider + '@' + identity['fingerprint'], 'fps': fps, 'minFrames': minimum, 'maxFrames': maximum,
            'frameMultiple': multiple, 'frameOffset': offset, 'referenceTailFrames': 0,
            'parameters': display['parameters'], **prompt_defaults(), **adapters,
            'conditions': {'referenceVideo': True, 'firstImage': False, 'objectReferenceComposite': False, 'history': False, 'audio': any(field['key'] == 'audio' for field in self.profile['parameters'])},
            'samplingNote': display.get('samplingNote', msg('backend.adapters.providers.local-reference.the-current-model-provider-determines-the-sampling-step-range'))}

    def load(self, *, report=None):
        self.renderer.load(report=report)

    def render_segment(self, *, video, image, prompt, parameters, output, progress, adapters=None, **kwargs):
        fields = {field['key'] for field in self.profile['parameters']}
        extra = {'adapters': adapters or []} if hasattr(self.renderer, 'adapter_catalog') else {}
        if adapters and not extra: raise ValueError(msg('backend.adapters.providers.local-reference.this-local-model-does-not-support-lora-yet'))
        return self.renderer.render(video=video, prompt=prompt, parameters={key: value for key, value in parameters.items() if key in fields},
            output=output, progress=progress, **extra)
