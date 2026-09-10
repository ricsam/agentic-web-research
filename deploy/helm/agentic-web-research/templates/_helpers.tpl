{{- define "agentic-web-research.name" -}}
agentic-web-research
{{- end -}}

{{- define "agentic-web-research.fullname" -}}
{{ include "agentic-web-research.name" . }}
{{- end -}}

{{- define "agentic-web-research.secretName" -}}
{{- default (include "agentic-web-research.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{- define "agentic-web-research.placement" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
