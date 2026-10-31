window.__ModuleLoader__.load({
  id: '@albaincompleta/dsh-cu-client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const { jsx, jsxs } = require('react/jsx-runtime')
    const react = require('react')

    // Tool cards for every tool this plugin registers. Results are the JSON
    // strings the tools return; the card never interprets them as instructions.
    const TOOLS = {
      d1_browser_subgoal: '浏览器子目标',
      browser_observe: '页面观察',
      browser_extract: '结构化提取',
      browser_navigate: '打开页面',
      browser_tabs: '标签页',
      browser_upload: '上传文件',
      browser_downloads: '下载',
      browser_control: '运行控制',
      browser_skill_publish: '发布技能',
      computer_subgoal: '原生子目标',
      computer_control: '原生控制',
      computer_skill_publish: '原生发布',
    }

    const STATUS = {
      success: { text: '完成', color: '#16a34a' },
      blocked: { text: '已阻止', color: '#d97706' },
      escalated: { text: '已升级', color: '#dc2626' },
      confirmation_required: { text: '等待批准', color: '#d97706' },
      paused: { text: '已暂停', color: '#6b7280' },
      stopped: { text: '已停止', color: '#6b7280' },
      takeover: { text: '已接管', color: '#2563eb' },
      running: { text: '执行中', color: '#2563eb' },
      failed: { text: '失败', color: '#dc2626' },
    }

    function textOf(block) {
      if (block === undefined || block === null) return null
      const content = block.content
      if (!Array.isArray(content)) return null
      const text = content
        .map(item => (item && item.type === 'text' ? item.text : item === undefined ? '' : JSON.stringify(item)))
        .filter(Boolean)
        .join('\n')
      return text === '' ? null : text
    }

    function payloadOf(block) {
      const text = textOf(block)
      if (text === null) return null
      try {
        const parsed = JSON.parse(text)
        return typeof parsed === 'object' && parsed !== null ? parsed : null
      } catch {
        return null
      }
    }

    function summaryOf(tool, payload) {
      if (payload === null) return ''
      let specific = ''
      if (tool === 'browser_observe') {
        const count = payload.observation && Array.isArray(payload.observation.elements)
          ? payload.observation.elements.length
          : null
        if (count !== null) specific = `${count} 个元素 · ${payload.observation.url || ''}`
      } else if (tool === 'browser_tabs') {
        const tabs = Array.isArray(payload.tabs) ? payload.tabs.length : null
        if (tabs !== null) specific = `${tabs} 个标签页${payload.action === 'list' ? '' : ` · ${payload.action}`}`
      } else if (tool === 'browser_extract') {
        const fields = payload.data && typeof payload.data === 'object' ? Object.keys(payload.data) : []
        if (fields.length > 0) specific = fields.join(', ')
      } else if (tool === 'browser_upload' || tool === 'browser_downloads') {
        const files = payload.files ?? (payload.download && payload.download.name ? [payload.download.name] : [])
        if (Array.isArray(files) && files.length > 0) specific = files.join(', ')
      } else if (tool === 'browser_navigate') {
        specific = payload.url || ''
      }
      if (specific !== '') return specific
      return typeof payload.reason === 'string' ? payload.reason : ''
    }

    function Card(props) {
      const tool = props.toolName
      const settled = props.block !== undefined && props.block !== null && 'kind' in props.block
      const payload = settled ? payloadOf(props.block) : null
      const statusKey = payload && typeof payload.status === 'string' ? payload.status : settled ? 'failed' : 'running'
      const status = STATUS[statusKey] ?? STATUS.running
      const [open, setOpen] = react.useState(false)
      const label = TOOLS[tool] ?? tool
      const summary = settled ? summaryOf(tool, payload) : '准备执行'
      const detail = settled && payload !== null ? JSON.stringify(payload, null, 2) : null
      return jsxs('div', {
        'data-dsh-cu-card': tool,
        'data-dsh-cu-status': statusKey,
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px',
          border: '1px solid rgba(127,127,127,.25)', borderRadius: '10px', margin: '6px 0',
          fontSize: '13px', lineHeight: '1.45',
        },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px' },
            children: [
              jsx('span', {
                style: { fontWeight: '600' },
                children: label,
              }),
              jsx('span', {
                'data-dsh-cu-chip': statusKey,
                style: {
                  color: status.color, border: `1px solid ${status.color}`,
                  borderRadius: '999px', padding: '0 8px', fontSize: '11px',
                },
                children: status.text,
              }),
              payload && payload.route
                ? jsx('span', {
                  style: { opacity: 0.7, fontSize: '11px' },
                  children: payload.route === 'skill' ? '已验证技能' : payload.route === 'd1' ? '本地决策' : '人工',
                })
                : null,
              detail === null
                ? null
                : jsx('button', {
                  type: 'button',
                  'data-dsh-cu-toggle': '',
                  onClick: () => setOpen(value => !value),
                  style: {
                    marginLeft: 'auto', background: 'none', border: '1px solid rgba(127,127,127,.35)',
                    borderRadius: '6px', padding: '0 6px', fontSize: '11px', cursor: 'pointer', color: 'inherit',
                  },
                  children: open ? '收起' : '详情',
                }),
            ],
          }),
          summary === '' ? null : jsx('div', {
            style: { opacity: 0.75, fontSize: '12px', wordBreak: 'break-all' },
            children: summary,
          }),
          open && detail !== null
            ? jsx('pre', {
              style: {
                margin: 0, padding: '8px', borderRadius: '6px', maxHeight: '260px', overflow: 'auto',
                background: 'rgba(127,127,127,.08)', fontSize: '11px', whiteSpace: 'pre-wrap',
              },
              children: detail,
            })
            : null,
        ],
      })
    }

    function apply(ctx) {
      for (const tool of Object.keys(TOOLS)) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: tool,
          id: `dsh-cu-${tool}`,
        }, Card))
      }
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
