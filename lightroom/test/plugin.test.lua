-- Kjøres med «bash kjor.sh». Test av Foto-pluginen i fengari, med en «streng» etterligning av Lightroom:
--  * kall som yielder i Lightroom (katalog, LrHttp, sleep) feiler inni vanlig pcall og utenfor oppgaver
--  * skriving til katalogen krever withWriteAccessDo, og nye objekter kan ikke leses i samme skrivelås
-- Alt går mot en lokal testserver; resultatet sjekkes direkte i databasen.

local PLUGIN, IMG, TMP, SERVER, TOKEN = os.getenv('PLUGIN'), os.getenv('IMG'), os.getenv('TMP'), os.getenv('SERVER'), os.getenv('TOKEN')
package.path = PLUGIN .. '/?.lua;' .. package.path
MAC_ENV = true
_PLUGIN = { id = 'net.dalhus.foto', path = PLUGIN }

-- io/os-shim (fengari har ikke io.open) -----------------------------------------------------
io.open = function(path, mode)
	mode = mode or 'r'
	if mode:sub(1, 1) == 'r' then
		local size = __size(path)
		if size < 0 then return nil, 'finnes ikke' end
		local pos = 0
		local f = {}
		function f:seek(whence, off)
			whence, off = whence or 'cur', off or 0
			if whence == 'set' then pos = off elseif whence == 'end' then pos = size + off else pos = pos + off end
			return pos
		end
		function f:read(n)
			if type(n) ~= 'number' then
				local s = __readRange(path, pos, size - pos)
				pos = size
				return s
			end
			if pos >= size then return nil end
			local s = __readRange(path, pos, n)
			pos = pos + #s
			return s
		end
		function f:close() end
		return f
	end
	if mode:sub(1, 1) == 'w' then __rm(path) end
	return { write = function(self, s) __append(path, s) return self end, close = function() end }
end
os.remove = function(p) __rm(p) return true end
os.rename = function(a, b) __rename(a, b) return true end

-- Lightroom-strenghet -------------------------------------------------------------------------
local violations = {}
local function violation(msg) violations[#violations + 1] = msg .. '\n' .. debug.traceback('', 3) end
local realPcall = pcall
local plainDepth = 0
pcall = function(f, ...)
	plainDepth = plainDepth + 1
	local res = table.pack(realPcall(f, ...))
	plainDepth = plainDepth - 1
	return table.unpack(res, 1, res.n)
end
local inTask = false
local gate, gateCounter = nil, 0
local function yields(what, notInGate)
	if plainDepth > 0 then violation('«' .. what .. '» kalt inni vanlig pcall (yielder i Lightroom)') end
	if not inTask then violation('«' .. what .. '» kalt utenfor en oppgave (LrTasks)') end
	if notInGate and gate then violation('«' .. what .. '» kalt inni withWriteAccessDo') end
end
local function needsGate(what) if not gate then violation('«' .. what .. '» krever withWriteAccessDo') end end
local function sameGate(obj, what)
	if gate and rawget(obj, '_gate') == gate.id then violation('«' .. what .. '» lest i samme skrivelås som objektet ble laget i') end
end

local function copy(t)
	if type(t) ~= 'table' then return t end
	local o = {}
	for k, v in pairs(t) do o[k] = copy(v) end
	return o
end

-- Etterlignede Lightroom-moduler ---------------------------------------------------------------
local modules = {}
local httpFaults, httpLog, sleeps = {}, {}, {}
browserOpened, browserHook = {}, nil
local function doHttp(method, url, headers, body, form)
	yields('LrHttp', true)
	local short = method .. ' ' .. url:gsub('^https?://[^/]+', '')
	httpLog[#httpLog + 1] = short
	for i, f in ipairs(httpFaults) do
		if short:find(f.pattern, 1, true) then
			table.remove(httpFaults, i)
			if f.errorCode then return nil, { error = { errorCode = f.errorCode, name = 'simulert ' .. f.errorCode } } end
			return '{"error":"simulert"}', { status = f.status }
		end
	end
	local h = {}
	for _, x in ipairs(headers or {}) do h[#h + 1] = x.field .. ': ' .. x.value end
	local res, status = __http(method, url, table.concat(h, '\n'), body, form)
	if not res then return nil, { error = { errorCode = status, name = 'kunne ikke koble til' } } end
	return res, { status = status }
end
modules.LrHttp = {
	get = function(url, headers) return doHttp('GET', url, headers, nil, nil) end,
	post = function(url, body, headers, method) return doHttp(method or 'POST', url, headers, body, nil) end,
	postMultipart = function(url, content, headers, timeout, callback)
		if callback then callback(0.5) callback(1) end
		return doHttp('POST', url, headers, nil, require('FotoJSON').encode(content))
	end,
	openUrlInBrowser = function(url)
		browserOpened[#browserOpened + 1] = url
		if browserHook then browserHook(url) end
	end,
}
modules.LrSystemInfo = { computerName = function() return 'Test-Mac' end }
local H264 = '4e49434b-4832-3634-fbfb-fbfbfbfbfbfb'
local function videoPreset(format, name, id)
	return { formatID = function() return format end, name = function() return name end, _id = id }
end
videoPresets = {
	videoPreset('4e49434b-4450-5820-fbfb-fbfbfbfbfbfb', 'Original', 'dpx'),
	videoPreset(H264, 'Høy', 'h264-high'),
	videoPreset(H264, 'Maks', 'h264-max'),
	videoPreset(H264, 'Lav', 'h264-low'),
}
modules.LrExportSettings = {
	videoExportPresets = function()
		if videoPresetsFail then error('ikke tilgjengelig') end
		local out = {}
		for _, p in pairs(videoPresets) do out[#out + 1] = p end
		return out
	end,
	applyVideoExportPreset = function(s, preset)
		s.LR_export_videoFormat = preset.formatID()
		s.LR_export_videoPreset = preset._id
	end,
}
modules.LrTasks = {
	pcall = function(f, ...)
		if not inTask then violation('LrTasks.pcall utenfor oppgave') end
		return realPcall(f, ...)
	end,
	startAsyncTask = function(f)
		local prev = inTask
		inTask = true
		local ok, err = xpcall(f, debug.traceback)
		inTask = prev
		if not ok then error(err, 0) end
	end,
	sleep = function(s) yields('LrTasks.sleep', true) sleeps[#sleeps + 1] = s end,
	canYield = function() return inTask end,
}
local prefs = {}
modules.LrPrefs = { prefsForPlugin = function() return prefs end }
local dialogs = { messages = {}, modalResult = 'ok' }
modules.LrDialogs = {
	message = function(msg, info, style) dialogs.messages[#dialogs.messages + 1] = { msg = msg, info = info, style = style } end,
	presentModalDialog = function(args)
		dialogs.lastModal = args
		if dialogs.modalHook then dialogs.modalHook(args) end
		return dialogs.modalResult
	end,
	attachErrorDialogToFunctionContext = function() end,
	runOpenPanel = function(args) dialogs.lastOpenPanel = args return dialogs.openPanelResult end,
}
local factory = setmetatable({}, { __index = function(_, kind)
	return function(self, t) t = t or {} t._kind = kind return t end
end })
modules.LrView = {
	bind = function(k) return { bind = k } end,
	share = function(k) return { share = k } end,
	osFactory = function() return factory end,
}
local function propertyTable()
	local data, observers, pt = {}, {}, {}
	setmetatable(pt, {
		__index = function(_, k)
			if k == 'addObserver' then
				return function(_, key, fn) observers[key] = observers[key] or {} table.insert(observers[key], fn) end
			end
			return data[k]
		end,
		__newindex = function(_, k, v)
			data[k] = v
			for _, fn in ipairs(observers[k] or {}) do fn(pt, k, v) end
		end,
	})
	return pt
end
modules.LrBinding = { makePropertyTable = function() return propertyTable() end }
modules.LrFunctionContext = { callWithContext = function(name, fn, ...) return fn({}, ...) end }
modules.LrPathUtils = {
	leafName = function(p) return p:match('([^/]+)$') end,
	child = function(a, b) return a .. '/' .. b end,
	getStandardFilePath = function() return TMP .. '/home' end,
}
modules.LrMD5 = { digest = function(s) return __md5(s) end }
modules.LrDate = { currentTime = function() return os.time() + os.clock() end, timeToUserFormat = function(_, fmt) return os.date(fmt) end }
modules.LrFileUtils = {
	delete = function(p) __rm(p) return true end,
	exists = function(p) if __isdir(p) then return 'directory' end return __exists(p) and 'file' or false end,
	createAllDirectories = function(p) __mkdir(p) return true end,
	fileAttributes = function(p) local n = __size(p) if n < 0 then return nil end return { fileSize = n } end,
	move = function(a, b) __rename(a, b) return __exists(b) end,
}
local progressScopes = {}
modules.LrProgressScope = setmetatable({}, { __call = function(_, args)
	local scope = { title = args and args.title, captions = {}, canceled = false }
	function scope:setCaption(c) self.captions[#self.captions + 1] = c end
	function scope:setPortionComplete() end
	function scope:isCanceled() return self.canceled end
	function scope:done() self.finished = true end
	progressScopes[#progressScopes + 1] = scope
	return scope
end })
local revealed
modules.LrShell = { revealInShell = function(p) revealed = p end }

-- Etterlignet katalog -------------------------------------------------------------------------
local catalog = { _services = {} }
modules.LrApplication = { activeCatalog = function() return catalog end }
function import(name) return assert(modules[name], 'mangler mock for ' .. name) end

local Obj = {}
local nextLocalId = 1000
local function mkObj(kind, name, parent, service, extra)
	nextLocalId = nextLocalId + 1
	local o = { _id = nextLocalId, _name = name, _parent = parent, _kind = kind, _children = {}, _photos = {}, _service = service, _gate = gate and gate.id }
	for k, v in pairs(extra or {}) do o[k] = v end
	setmetatable(o, { __index = function(t, k)
		if k == 'localIdentifier' then sameGate(t, 'localIdentifier') return rawget(t, '_id') end
		if k == 'catalog' then return catalog end
		return Obj[k]
	end })
	local container = parent or service
	if container then table.insert(container._children, o) end
	return o
end
local function childrenOf(self, kind)
	local out = {}
	for _, c in ipairs(self._children) do if c._kind == kind then out[#out + 1] = c end end
	return out
end
function Obj:type() return self._kind end
function Obj:getName() yields('getName') sameGate(self, 'getName') return self._name end
function Obj:getParent() yields('getParent') sameGate(self, 'getParent') return self._parent end
function Obj:getChildCollections() yields('getChildCollections') return childrenOf(self, 'LrPublishedCollection') end
function Obj:getChildCollectionSets() yields('getChildCollectionSets') return childrenOf(self, 'LrPublishedCollectionSet') end
function Obj:getPhotos()
	yields('getPhotos') sameGate(self, 'getPhotos')
	local out = {}
	for i, p in ipairs(self._photos) do out[i] = p end
	return out
end
function Obj:isSmartCollection() yields('isSmartCollection') sameGate(self, 'isSmartCollection') return self._smart == true end
function Obj:getSearchDescription()
	yields('getSearchDescription')
	if not self._smart then error('Ikke en smart samling') end
	return copy(self._search)
end
function Obj:getCollectionInfoSummary()
	yields('getCollectionInfoSummary')
	return { collectionSettings = copy(self._settings), isDefaultCollection = self._default == true, name = self._name }
end
function Obj:getCollectionSetInfoSummary()
	yields('getCollectionSetInfoSummary')
	return { collectionSettings = copy(self._settings), isDefaultCollection = false, name = self._name }
end
function Obj:setCollectionSettings(t) needsGate('setCollectionSettings') self._settings = copy(t) end
function Obj:setCollectionSetSettings(t) needsGate('setCollectionSetSettings') self._settings = copy(t) end
function Obj:addPhotos(photos)
	needsGate('addPhotos')
	if self._smart then error('addPhotos på smart samling') end
	for _, p in ipairs(photos) do
		local found = false
		for _, q in ipairs(self._photos) do if q == p then found = true end end
		if not found then table.insert(self._photos, p) end
	end
end
function Obj:delete()
	needsGate('delete')
	local container = self._parent or self._service
	for i, c in ipairs(container._children) do if c == self then table.remove(container._children, i) break end end
end
function Obj:getPluginId() yields('getPluginId') return self._pluginId end
function Obj:getPublishSettings() yields('getPublishSettings') return self._publishSettings end
function Obj:getRemoteId() yields('getRemoteId') return self._remoteId end
function Obj:getRemoteUrl() yields('getRemoteUrl') return self._remoteUrl end
function Obj:setRemoteId(id) needsGate('setRemoteId') self._remoteId = id end
function Obj:setRemoteUrl(url) needsGate('setRemoteUrl') self._remoteUrl = url end
function Obj:setName(name)
	needsGate('setName')
	for _, c in ipairs((self._parent or self._service)._children) do
		if c ~= self and c._name:lower() == name:lower() then return false end
	end
	self._name = name
	return true
end
function Obj:setParent(parent)
	needsGate('setParent')
	if parent and parent._service ~= self._service then error('setParent: mappe i en annen tjeneste') end
	local p = parent
	while p do
		if p == self then error('setParent: kan ikke legge en mappe i seg selv') end
		p = p._parent
	end
	local old = self._parent or self._service
	for i, c in ipairs(old._children) do if c == self then table.remove(old._children, i) break end end
	self._parent = parent
	table.insert((parent or self._service)._children, self)
end
local function publishedPhoto(entry)
	return {
		getRemoteId = function() return entry.remoteId end,
		getRemoteUrl = function() return entry.url end,
		getPhoto = function() return entry.photo end,
		getEditedFlag = function() return false end,
	}
end
function Obj:getPublishedPhotos()
	yields('getPublishedPhotos')
	local out = {}
	for _, p in ipairs(self._photos) do
		out[#out + 1] = publishedPhoto((self._published and self._published[p]) or { photo = p })
	end
	return out
end
function Obj:addPhotoByRemoteId(photo, remoteId, url, published)
	needsGate('addPhotoByRemoteId')
	sameGate(photo, 'bilde importert med addPhoto, brukt')
	local member = false
	for _, q in ipairs(self._photos) do if q == photo then member = true end end
	if self._smart and not member then error('addPhotoByRemoteId: bildet er ikke med i det smarte albumet') end
	if not member then table.insert(self._photos, photo) end
	self._published = self._published or {}
	self._published[photo] = { photo = photo, remoteId = remoteId, url = url, published = published }
end
function Obj:removePhotos(photos)
	needsGate('removePhotos')
	if self._smart then error('removePhotos på smart samling') end
	for _, p in ipairs(photos) do
		for i, q in ipairs(self._photos) do if q == p then table.remove(self._photos, i) break end end
		if self._published then self._published[p] = nil end
	end
end
local function create(service, kind, name, parent, canReturn, extra)
	needsGate('create ' .. kind)
	-- Som Lightroom: samme navn (uten hensyn til store/små bokstaver) gir den som finnes (canReturnExisting)
	-- eller nil – og alltid nil når navnet er tatt av noe av en annen type.
	for _, c in ipairs((parent or service)._children) do
		if c._name:lower() == name:lower() then
			if c._kind == kind and canReturn then return c end
			return nil
		end
	end
	return mkObj(kind, name, parent, service, extra)
end
function Obj:createPublishedCollection(name, parent, canReturn) return create(self, 'LrPublishedCollection', name, parent, canReturn) end
function Obj:createPublishedCollectionSet(name, parent, canReturn) return create(self, 'LrPublishedCollectionSet', name, parent, canReturn) end
function Obj:createPublishedSmartCollection(name, search, parent, canReturn)
	return create(self, 'LrPublishedCollection', name, parent, canReturn, { _smart = true, _search = copy(search) })
end
function catalog:getPublishServices(pluginId)
	yields('getPublishServices')
	local out = {}
	for _, s in ipairs(self._services) do if not pluginId or s._pluginId == pluginId then out[#out + 1] = s end end
	return out
end
function catalog:withWriteAccessDo(name, fn)
	yields('withWriteAccessDo', true)
	if gate then violation('nestet withWriteAccessDo') end
	gateCounter = gateCounter + 1
	gate = { id = gateCounter, name = name }
	local ok, err = realPcall(fn)
	gate = nil
	if not ok then error(err, 0) end
	return 'executed'
end
local function service(name, pluginId)
	local s = mkObj('LrPublishService', name, nil, nil, { _pluginId = pluginId })
	table.insert(catalog._services, s)
	return s
end
local photoRegistry = {}
local function photo(id, meta, raw)
	local existing = photoRegistry[id]
	if existing then
		if meta then existing._meta = meta end
		if raw then existing._raw = raw end
		return existing
	end
	local p = setmetatable({ _id = id, _meta = meta or {}, _raw = raw or {} }, { __index = function(t, k)
		if k == 'localIdentifier' then return rawget(t, '_id') end
		if k == 'getFormattedMetadata' then
			return function(self, key) yields('getFormattedMetadata') return self._meta[key] end
		end
		if k == 'getRawMetadata' then
			return function(self, key) yields('getRawMetadata') return self._raw[key] end
		end
	end })
	photoRegistry[id] = p
	return p
end
catalog._photos = {}
local importedPaths = {}
local function catalogPhoto(id, raw)
	local p = photo(id, nil, raw)
	table.insert(catalog._photos, p)
	return p
end
function catalog:getAllPhotos()
	yields('getAllPhotos', true)
	local out = {}
	for i, p in ipairs(self._photos) do out[i] = p end
	return out
end
function catalog:batchGetRawMetadata(photos, keys)
	yields('batchGetRawMetadata', true)
	local out = {}
	for _, p in ipairs(photos) do
		local m = {}
		for _, k in ipairs(keys or {}) do m[k] = p._raw[k] end
		out[p] = m
	end
	return out
end
local nextPhotoId = 5000
function catalog:addPhoto(path)
	needsGate('addPhoto')
	if not __exists(path) then error('addPhoto: fila finnes ikke: ' .. tostring(path)) end
	for _, p in ipairs(self._photos) do
		if p._raw.path == path then error('addPhoto: fila er allerede i katalogen') end
	end
	nextPhotoId = nextPhotoId + 1
	local p = photo(nextPhotoId, nil, { path = path, isVirtualCopy = false })
	rawset(p, '_gate', gate.id)
	table.insert(self._photos, p)
	importedPaths[#importedPaths + 1] = path
	return p
end
function catalog:findPhotoByPath(path)
	yields('findPhotoByPath')
	for _, p in ipairs(self._photos) do if p._raw.path == path then return p end end
	return nil
end

-- Hjelpere ------------------------------------------------------------------------------------
local failures = 0
local function check(cond, msg)
	if cond then print('  ok    ' .. msg) else failures = failures + 1 print('  FEIL  ' .. msg) end
end
local function task(fn, ...)
	local prev = inTask
	inTask = true
	local res = table.pack(xpcall(fn, debug.traceback, ...))
	inTask = prev
	if not res[1] then error(res[2], 0) end
	return table.unpack(res, 2, res.n)
end
local function taskErr(fn, ...)
	local prev = inTask
	inTask = true
	local res = table.pack(realPcall(fn, ...))
	inTask = prev
	return res[1], res[2]
end
local function blocking(fn, ...)
	local prev = inTask
	inTask = false
	local res = table.pack(xpcall(fn, debug.traceback, ...))
	inTask = prev
	if not res[1] then error(res[2], 0) end
	return table.unpack(res, 2, res.n)
end
local JSON = require 'FotoJSON'
local function sql(q) return JSON.decode(__sql(q)) end
local function one(q) return sql(q)[1] end
local function find(tree, pred)
	if type(tree) ~= 'table' then return nil end
	if pred(tree) then return tree end
	for _, v in pairs(tree) do
		if type(v) == 'table' then
			local r = find(v, pred)
			if r then return r end
		end
	end
end
local function anonStatus(path)
	local body, status = __http('GET', SERVER .. path, '', nil, nil)
	return status
end

-- Pluginen ------------------------------------------------------------------------------------
local provider = require 'FotoServiceProvider'
local FotoAPI = require 'FotoAPI'
local foto = service('Foto: 127.0.0.1', 'net.dalhus.foto')

print('1. Innstillinger for tjenesten')
local settings = propertyTable()
settings.serverUrl = SERVER
settings.apiToken = TOKEN
settings.serviceKey = ''
settings.siteName = ''
blocking(provider.startDialog, settings)
check(#settings.serviceKey == 16, 'serviceKey generert')
check(settings.siteName == '127.0.0.1', 'siteName fra adressen: ' .. tostring(settings.siteName))
settings.serverUrl = 'foto.example.org/'
check(settings.siteName == 'foto.example.org', 'siteName følger adressen (' .. tostring(settings.siteName) .. ')')
settings.serverUrl = SERVER
check(tostring(settings.connectionStatus):find('Tilkoblet som test@example.com', 1, true), 'status ved åpning: ' .. tostring(settings.connectionStatus))
local sections = blocking(provider.sectionsForTopOfDialog, factory, settings)
local function btn(title) return find(sections, function(t) return t._kind == 'push_button' and t.title == title end) end
check(btn('Koble til Foto …') and btn('Koble fra') and btn('Avbryt'), 'knappene Koble til / Avbryt / Koble fra finnes')
check(not find(sections, function(t) return t._kind == 'password_field' end), 'ikke noe felt for API-nøkkel')
local bad = propertyTable()
bad.serverUrl, bad.apiToken = SERVER, 'fto_feil'
local ok1, e1 = taskErr(function() return FotoAPI.new(bad):me() end)
check(not ok1 and tostring(e1):find('ikke lenger koblet til', 1, true), 'feil nøkkel ber deg koble til på nytt: ' .. tostring(e1))
local ok2, e2 = taskErr(function() return FotoAPI.new({ serverUrl = 'http://127.0.0.1:9', apiToken = TOKEN }):me() end)
check(not ok2 and tostring(e2):find('Fikk ikke kontakt'), 'nede server gir lesbar feil: ' .. tostring(e2))
check(#sleeps == 0, 'test tilkobling prøver ikke på nytt')

print('1b. Koble til Foto (uten å lime inn nøkkel)')
local function codeOf(url) return url:match('/koble/([%u%d%-]+)$') end
local function tokens(name) return one("SELECT count(*) AS n FROM api_tokens WHERE name = '" .. name .. "'").n end
local fresh = propertyTable()
fresh.serverUrl, fresh.apiToken, fresh.serviceKey, fresh.siteName = SERVER, '', '', ''
blocking(provider.startDialog, fresh)
check(tostring(fresh.connectionStatus):find('Ikke tilkoblet', 1, true), 'ny tjeneste: ' .. tostring(fresh.connectionStatus))
sections = blocking(provider.sectionsForTopOfDialog, factory, fresh)
local seen = {}
browserHook = function(url)
	local code = codeOf(url)
	seen.code = code
	seen.statusInLr = fresh.connectionStatus
	seen.anonStatus = __browser('GET', url, false)
	local st, body = __browser('GET', url, true)
	seen.pageOk = st == 200 and body:find(code, 1, true) ~= nil and body:find('Test-Mac', 1, true) ~= nil
	seen.approve = __browser('POST', url .. '?/approve', true)
end
sleeps = {}
blocking(btn('Koble til Foto …').action)
check(#browserOpened == 1 and seen.code, 'nettleseren åpnet ' .. tostring(browserOpened[1]))
check(tostring(seen.statusInLr):find(tostring(seen.code), 1, true), 'Lightroom viser samme kode: ' .. tostring(seen.statusInLr))
check(seen.anonStatus == 303, 'siden krever innlogging (' .. tostring(seen.anonStatus) .. ')')
check(seen.pageOk, 'godkjenningssiden viser kode og maskinnavn')
check(seen.approve == 200, 'Koble til i nettleseren (' .. tostring(seen.approve) .. ')')
check(type(fresh.apiToken) == 'string' and fresh.apiToken:sub(1, 4) == 'fto_', 'nøkkelen havnet i innstillingene')
check(tostring(fresh.connectionStatus):find('Tilkoblet som test@example.com', 1, true), 'status: ' .. tostring(fresh.connectionStatus))
check(fresh.connecting == false, 'knappene er aktive igjen')
check(tokens('Lightroom – Test-Mac') == 1, 'nøkkelen heter «Lightroom – Test-Mac» på nettstedet')
local okMe = taskErr(function() return FotoAPI.new(fresh):me() end)
check(okMe, 'den nye nøkkelen virker')
check(#sleeps >= 1 and sleeps[1] == 2, 'venter 2 s mellom hver spørring')

-- Nøkkelen gis bare ut én gang, og en ukjent hemmelighet gir «expired».
local okS, start = taskErr(function() return FotoAPI.connectStart(SERVER, 'Andre-Mac') end)
check(okS and start.code and start.pollSecret, 'start direkte')
__browser('POST', start.url .. '?/approve', true)
local p1 = task(function() return FotoAPI.connectPoll(SERVER, start.pollSecret) end)
local p2 = task(function() return FotoAPI.connectPoll(SERVER, start.pollSecret) end)
check(p1.status == 'approved' and p2.status == 'expired' and p2.token == nil, 'nøkkelen hentes bare én gang (' .. p1.status .. ', ' .. p2.status .. ')')
local _, page = __browser('GET', start.url, true)
check(page:find('Fant ikke forespørselen', 1, true), 'brukt kode kan ikke godkjennes igjen')

-- Avbryt i nettleseren
local denied = propertyTable()
denied.serverUrl, denied.apiToken = SERVER, ''
blocking(provider.startDialog, denied)
sections = blocking(provider.sectionsForTopOfDialog, factory, denied)
browserHook = function(url) __browser('POST', url .. '?/deny', true) end
blocking(btn('Koble til Foto …').action)
check(denied.apiToken == '' and tostring(denied.connectionStatus):find('avbrutt', 1, true), 'avbrutt i nettleseren: ' .. tostring(denied.connectionStatus))

-- Avbryt i Lightroom mens vi venter
local cancelled = propertyTable()
cancelled.serverUrl, cancelled.apiToken = SERVER, ''
blocking(provider.startDialog, cancelled)
sections = blocking(provider.sectionsForTopOfDialog, factory, cancelled)
local cancelBtn = btn('Avbryt')
browserHook = function(url) seen.cancelUrl = url cancelBtn.action() end
local pollsBefore = 0
for _, l in ipairs(httpLog) do if l:find('connect/poll', 1, true) then pollsBefore = pollsBefore + 1 end end
blocking(btn('Koble til Foto …').action)
local pollsAfter = 0
for _, l in ipairs(httpLog) do if l:find('connect/poll', 1, true) then pollsAfter = pollsAfter + 1 end end
check(cancelled.connecting == false and cancelled.apiToken == '' and pollsAfter == pollsBefore, 'Avbryt i Lightroom stopper ventingen')
__browser('POST', seen.cancelUrl .. '?/approve', true) -- godkjent etterpå: Lightroom henter den ikke

-- Feil adresse / gammel server
local okBad, eBad = taskErr(function() return FotoAPI.connectStart('http://127.0.0.1:9', 'x') end)
check(not okBad and tostring(eBad):find('Fikk ikke kontakt', 1, true), 'nede server: ' .. tostring(eBad))

-- Koble fra
local before = tokens('Lightroom – Test-Mac')
sections = blocking(provider.sectionsForTopOfDialog, factory, fresh)
blocking(btn('Koble fra').action)
check(fresh.apiToken == '' and tokens('Lightroom – Test-Mac') == before - 1, 'Koble fra glemmer nøkkelen og sletter den på nettstedet')
browserHook = nil
sleeps = {}

print('2. Innstillingsvinduer for album og mappe')
local cs1 = {}
blocking(provider.viewForCollectionSettings, factory, settings, { collectionSettings = cs1 })
check(cs1.visibility == 'public' and cs1.allowDownload == false, 'album: offentlig, ingen nedlasting som standard')
local cs2 = {}
blocking(provider.viewForCollectionSetSettings, factory, settings, { collectionSettings = cs2 })
check(cs2.visibility == 'public' and cs2.allowDownload == nil, 'mappe: offentlig som standard')

-- Struktur «laget i Lightroom»
local setReiser = mkObj('LrPublishedCollectionSet', 'Reiser', nil, foto, { _settings = { visibility = 'public' } })
local colLofoten = mkObj('LrPublishedCollection', 'Lofoten 2026', setReiser, foto, { _settings = { visibility = 'public', allowDownload = true } })
local setFamilie = mkObj('LrPublishedCollectionSet', 'Familie', nil, foto, { _settings = { visibility = 'private' } })
local colJul = mkObj('LrPublishedCollection', 'Jul', setFamilie, foto, { _settings = { visibility = 'public', allowDownload = false } })
local colUtvalgte = mkObj('LrPublishedCollection', 'Utvalgte', nil, foto) -- ingen innstillinger lagret

local recorded = {}
local function publish(collection, photos)
	local renditions = {}
	for i, p in ipairs(photos) do
		local path = TMP .. '/render-' .. i .. '-' .. p.file
		__copy(IMG .. '/' .. p.file, path)
		renditions[i] = {
			photo = photo(p.lrId or i, p.meta, p.video and { isVideo = true, dateTimeOriginalISO8601 = p.taken } or nil),
			publishedPhotoId = p.publishedId,
			destinationPath = path,
			-- p.bug: Lightroom-feilen der waitForRender svarer «false, nil» for video som er eksportert.
			waitForRender = function() if p.bug then return false, nil end return true, path end,
			recordPublishedPhotoId = function(_, id) p.newId = id end,
			recordPublishedPhotoUrl = function(_, url) p.url = url end,
			uploadFailed = function(_, msg) p.failed = msg end,
			_path = path,
		}
	end
	local session = {
		countRenditions = function() return #renditions end,
		recordRemoteCollectionId = function(_, id) recorded.albumId = id end,
		recordRemoteCollectionUrl = function(_, url) recorded.albumUrl = url end,
	}
	local ctx = {
		exportSession = session,
		propertyTable = settings,
		publishedCollection = collection,
		publishService = foto,
		configureProgress = function()
			return { setPortionComplete = function() end, isCanceled = function() return false end, done = function() end }
		end,
		renditions = function()
			local i = 0
			return function() i = i + 1 if renditions[i] then return i, renditions[i] end end
		end,
	}
	task(provider.processRenderedPhotos, {}, ctx)
	local clean = true
	for _, r in ipairs(renditions) do if __exists(r._path) then clean = false end end
	return clean
end
local function nodeByRef(kind, obj)
	return one(string.format("SELECT * FROM nodes WHERE lr_ref = 'lr:%s:%s:%d'", settings.serviceKey, kind, obj._id))
end

print('3. Publiser album i offentlig mappe')
local p1 = {
	{ file = 'lite-med-exif.jpg', lrId = 1, meta = { title = 'Reine', caption = 'Morgen, «Lofoten»', keywordTagsForExport = 'fjell, hav' } },
	{ file = 'rotert-orientation6.jpg', lrId = 2, meta = {} },
}
check(publish(colLofoten, p1), 'midlertidige eksportfiler slettet')
check(p1[1].newId and p1[2].newId and not p1[1].failed and not p1[2].failed, 'to bilder lastet opp')
local lofoten = nodeByRef('col', colLofoten)
local reiser = nodeByRef('set', setReiser)
check(lofoten and lofoten.visibility == 'public' and lofoten.allow_download == 1, 'album offentlig med nedlasting')
check(reiser and reiser.visibility == 'public' and lofoten.parent_id == reiser.id, 'ligger i mappa «Reiser»')
local ph = one("SELECT * FROM photos WHERE id = '" .. p1[1].newId .. "'")
check(ph.title == 'Reine' and ph.caption == 'Morgen, «Lofoten»' and ph.keywords:find('fjell') and ph.keywords:find('hav'), 'tittel, bildetekst og nøkkelord kom med')
check(recorded.albumId == lofoten.id and recorded.albumUrl:find('/a/' .. lofoten.id, 1, true), 'album-ID og URL registrert i Lightroom')
check(p1[1].url and p1[1].url:find('/i/' .. p1[1].newId, 1, true), 'bilde-URL registrert')

print('4. Publiser offentlig album i privat mappe')
check(publish(colJul, { { file = 'lite-med-exif.jpg', lrId = 3, meta = { title = 'Julaften' } } }), 'eksportfil slettet')
local familie = nodeByRef('set', setFamilie)
local jul = nodeByRef('col', colJul)
check(familie and familie.visibility == 'private', 'mappa «Familie» ble opprettet som privat')
check(jul and jul.visibility == 'public' and jul.parent_id == familie.id, 'albumet «Jul» ligger i den private mappa')
local st1, st2 = anonStatus('/familie/jul'), anonStatus('/a/' .. jul.id)
check(st1 ~= 200 and st2 ~= 200, 'ikke synlig uten innlogging (' .. tostring(st1) .. ', ' .. tostring(st2) .. ')')

print('5. Album uten lagrede innstillinger')
local p3 = { { file = 'lite-med-exif.jpg', lrId = 4, meta = {} } }
publish(colUtvalgte, p3)
local utvalgte = nodeByRef('col', colUtvalgte)
check(utvalgte and utvalgte.visibility == 'public' and utvalgte.parent_id == nil, 'offentlig album på toppnivå')
check(anonStatus('/utvalgte') == 200, 'synlig uten innlogging')

print('6. Ny versjon og bilde som er slettet på nettstedet')
local again = { { file = 'rotert-orientation6.jpg', lrId = 1, publishedId = p1[1].newId, meta = { title = 'Reine (ny)' } } }
publish(colLofoten, again)
check(again[1].newId == p1[1].newId, 'samme ID beholdt')
check(one("SELECT version, title FROM photos WHERE id = '" .. p1[1].newId .. "'").version == 2, 'versjon 2 på serveren')
local gone = { { file = 'lite-med-exif.jpg', lrId = 5, publishedId = 'finnesikke123', meta = {} } }
publish(colLofoten, gone)
check(gone[1].newId and gone[1].newId ~= 'finnesikke123', 'lastet opp som nytt bilde')

print('7. Egendefinert rekkefølge')
local order = { gone[1].newId, p1[2].newId, p1[1].newId }
task(provider.imposeSortOrderOnPublishedCollection, settings, { remoteCollectionId = lofoten.id, name = 'Lofoten 2026' }, order)
local rows = sql("SELECT id FROM photos WHERE album_id = '" .. lofoten.id .. "' ORDER BY sort_index")
check(rows[1].id == order[1] and rows[2].id == order[2] and rows[3].id == order[3], 'rekkefølgen på nettstedet følger Lightroom')

print('8. Endre album-innstillinger (på nett)')
task(provider.updateCollectionSettings, settings, { publishedCollection = colLofoten, name = 'Lofoten 2026', publishService = foto, collectionSettings = { visibility = 'private', allowDownload = false } })
colLofoten._settings = { visibility = 'private', allowDownload = false }
lofoten = nodeByRef('col', colLofoten)
check(lofoten.visibility == 'private' and lofoten.allow_download == 0, 'privat og uten nedlasting på nettstedet')

print('9. Endre album-innstillinger uten nett → sendes ved neste publisering')
local offline = propertyTable()
offline.serverUrl, offline.apiToken, offline.serviceKey = 'http://127.0.0.1:9', TOKEN, settings.serviceKey
local nMessages = #dialogs.messages
sleeps = {}
task(provider.updateCollectionSettings, offline, { publishedCollection = colLofoten, name = 'Lofoten 2026', publishService = foto, collectionSettings = { visibility = 'public', allowDownload = true } })
colLofoten._settings = { visibility = 'public', allowDownload = true }
check(#dialogs.messages == nMessages + 1 and dialogs.messages[#dialogs.messages].style == 'warning', 'advarsel vist: ' .. tostring(dialogs.messages[#dialogs.messages] and dialogs.messages[#dialogs.messages].msg))
check(#sleeps == 3, 'prøvde på nytt 3 ganger før den ga opp (' .. table.concat(sleeps, ',') .. ' s)')
check(tostring(prefs.pendingSettings):find(':album:' .. colLofoten._id, 1, true), 'endringen er husket')
check(nodeByRef('col', colLofoten).visibility == 'private', 'nettstedet er uendret så langt')
publish(colLofoten, { { file = 'lite-med-exif.jpg', lrId = 6, meta = {} } })
lofoten = nodeByRef('col', colLofoten)
check(lofoten.visibility == 'public' and lofoten.allow_download == 1, 'sendt ved publisering')
check(prefs.pendingSettings == '', 'ingen ventende endringer igjen')

print('10. Mappe-innstillinger')
task(provider.updateCollectionSetSettings, settings, { publishedCollection = setReiser, name = 'Reiser', publishService = foto, collectionSettings = { visibility = 'private' } })
setReiser._settings = { visibility = 'private' }
check(nodeByRef('set', setReiser).visibility == 'private', 'mappa «Reiser» er privat')
check(anonStatus('/reiser/lofoten-2026') ~= 200, 'album i privat mappe er skjult')
task(provider.updateCollectionSetSettings, offline, { publishedCollection = setReiser, name = 'Reiser', publishService = foto, collectionSettings = { visibility = 'public' } })
setReiser._settings = { visibility = 'public' }
check(nodeByRef('set', setReiser).visibility == 'private', 'uten nett: uendret på nettstedet')
publish(colLofoten, { { file = 'lite-med-exif.jpg', lrId = 7, meta = {} } })
check(nodeByRef('set', setReiser).visibility == 'public', 'mappa ble oppdatert da et album i den ble publisert')
check(prefs.pendingSettings == '', 'ingen ventende endringer igjen')

print('11. Navnebytte')
local colNy = mkObj('LrPublishedCollection', 'Aldri publisert', setReiser, foto, { _settings = { visibility = 'public' } })
task(provider.renamePublishedCollection, settings, { publishedCollection = colNy, name = 'Nytt navn', publishService = foto })
check(nodeByRef('col', colNy) == nil, 'upublisert album blir ikke opprettet av navnebytte')
task(provider.renamePublishedCollection, settings, { publishedCollection = colLofoten, name = 'Lofoten', publishService = foto })
colLofoten._name = 'Lofoten'
check(nodeByRef('col', colLofoten).name == 'Lofoten', 'albumet har nytt navn')
task(provider.renamePublishedCollection, settings, { publishedCollection = setReiser, name = 'Turer', publishService = foto })
setReiser._name = 'Turer'
check(nodeByRef('set', setReiser).name == 'Turer', 'mappa har nytt navn')

print('12. Flytting')
local setArkiv = mkObj('LrPublishedCollectionSet', 'Arkiv', nil, foto, { _settings = { visibility = 'private' } })
local setGammelt = mkObj('LrPublishedCollectionSet', 'Gammelt', setArkiv, foto, { _settings = { visibility = 'public' } })
-- Lightroom gir foreldrene i ukjent rekkefølge – her nærmeste først.
task(provider.reparentPublishedCollection, settings, { publishedCollection = colLofoten, name = 'Lofoten', publishService = foto,
	parents = { { localCollectionId = setGammelt._id, name = 'Gammelt' }, { localCollectionId = setArkiv._id, name = 'Arkiv' } } })
local arkiv, gammelt = nodeByRef('set', setArkiv), nodeByRef('set', setGammelt)
lofoten = nodeByRef('col', colLofoten)
check(arkiv and arkiv.visibility == 'private', 'ny mappe «Arkiv» opprettet som privat (som i Lightroom)')
check(gammelt and gammelt.parent_id == arkiv.id and lofoten.parent_id == gammelt.id, 'albumet ligger nå i Arkiv/Gammelt')
-- I Lightroom er albumet nå flyttet:
for i, c in ipairs(setReiser._children) do if c == colLofoten then table.remove(setReiser._children, i) break end end
colLofoten._parent = setGammelt
table.insert(setGammelt._children, colLofoten)
task(provider.reparentPublishedCollection, settings, { publishedCollection = colNy, name = 'Aldri publisert', publishService = foto,
	parents = { { localCollectionId = setArkiv._id, name = 'Arkiv' } } })
check(nodeByRef('col', colNy) == nil, 'upublisert album blir ikke opprettet av flytting')

print('13. Slette bilder (i bolker)')
local ids = { p1[2].newId }
for i = 1, 1200 do ids[#ids + 1] = 'falsk' .. i end
local deleted, before = {}, #httpLog
task(provider.deletePhotosFromPublishedCollection, settings, ids, function(id) deleted[#deleted + 1] = id end, colLofoten._id)
check(#deleted == #ids, 'deletedCallback kalt for alle ' .. #ids)
check(#httpLog - before == 3, 'sendt i 3 bolker')
check(one("SELECT count(*) AS n FROM photos WHERE id = '" .. p1[2].newId .. "'").n == 0, 'bildet er slettet på nettstedet')

print('14. Slette mappe med innhold')
task(provider.deletePublishedCollection, settings, { publishedCollection = setFamilie, name = 'Familie', publishService = foto })
check(nodeByRef('set', setFamilie) == nil and nodeByRef('col', colJul) == nil, 'mappa og albumet er borte')
check(one("SELECT count(*) AS n FROM photos WHERE album_id = '" .. jul.id .. "'").n == 0, 'bildene er borte')

print('15. Nye forsøk ved forbigående feil')
sleeps = {}
httpFaults[#httpFaults + 1] = { pattern = 'POST /api/v1/lr/sync', status = 502 }
local r1 = { { file = 'lite-med-exif.jpg', lrId = 8, meta = {} } }
publish(colUtvalgte, r1)
check(r1[1].newId and #sleeps == 1, '502 på synk: nytt forsøk lyktes')
local nBefore = one("SELECT count(*) AS n FROM photos WHERE album_id = '" .. utvalgte.id .. "'").n
httpFaults[#httpFaults + 1] = { pattern = 'POST /api/v1/albums/', errorCode = 'timedOut' }
local r2 = { { file = 'lite-med-exif.jpg', lrId = 9, meta = {} } }
sleeps = {}
publish(colUtvalgte, r2)
check(r2[1].failed and r2[1].failed:find('svarte ikke i tide', 1, true) and #sleeps == 0, 'tidsavbrudd på ny opplasting: ikke prøvd igjen (unngår duplikat): ' .. tostring(r2[1].failed))
check(one("SELECT count(*) AS n FROM photos WHERE album_id = '" .. utvalgte.id .. "'").n == nBefore, 'ingen duplikat')
httpFaults[#httpFaults + 1] = { pattern = '/replace', errorCode = 'timedOut' }
local r3 = { { file = 'lite-med-exif.jpg', lrId = 8, publishedId = r1[1].newId, meta = {} } }
sleeps = {}
publish(colUtvalgte, r3)
check(r3[1].newId == r1[1].newId and #sleeps == 1, 'tidsavbrudd på ny versjon: prøvd igjen og lyktes')
httpFaults[#httpFaults + 1] = { pattern = 'POST /api/v1/albums/', status = 503 }
local r4 = { { file = 'lite-med-exif.jpg', lrId = 10, meta = {} } }
sleeps = {}
publish(colUtvalgte, r4)
check(r4[1].newId and #sleeps == 1, '503 på opplasting: prøvd igjen og lyktes')

print('16. Ny tjeneste: tom standardsamling fjernes')
local fresh = service('Foto: ny', 'net.dalhus.foto')
local default = mkObj('LrPublishedCollection', 'Usortert', nil, fresh, { _default = true })
task(provider.didCreateNewPublishService, settings, { publishService = fresh, connectionName = 'ny' })
check(#fresh._children == 0, 'standardsamlingen er fjernet')
for i, s in ipairs(catalog._services) do if s == fresh then table.remove(catalog._services, i) break end end

print('17. Kopier fra SmugMug')
local smug = service('SmugMug: Eirik', 'com.smugmug.lightroom.publish')
service('Harddisk', 'com.adobe.lightroom.export.harddisk')
local sp = {}
for i = 1, 6 do sp[i] = photo(100 + i) end
local sPort = mkObj('LrPublishedCollectionSet', 'Portefølje', nil, smug, { _settings = { node = { Privacy = 'Public' } } })
local sNatur = mkObj('LrPublishedCollection', 'Natur', sPort, smug, { _settings = { Privacy = 'Public' }, _photos = { sp[1], sp[2] } })
mkObj('LrPublishedCollection', 'Kunde X', sPort, smug, { _settings = { album = { Privacy = 'Public', EffectivePrivacy = 'Unlisted' } }, _photos = { sp[3] } })
mkObj('LrPublishedCollection', 'Beste', sPort, smug, { _smart = true, _search = { combine = 'intersect', { criteria = 'rating', operation = '>=', value = 5 } }, _settings = { Privacy = 'Public' } })
local sPriv = mkObj('LrPublishedCollectionSet', 'Privat', nil, smug, { _settings = { Privacy = 'Private' } })
mkObj('LrPublishedCollection', 'Familie', sPriv, smug, { _photos = { sp[4] } })
mkObj('LrPublishedCollection', 'Diverse', nil, smug, { _settings = { Privacy = 'Public' }, _photos = { sp[1] } })
mkObj('LrPublishedCollection', 'Bestillinger', nil, smug, { _photos = { sp[5] } })
local modalCount = 0
dialogs.modalHook = function(args)
	modalCount = modalCount + 1
	local props = args.contents.bind_to_object
	if props.include4 ~= nil then props.include4 = false end -- fjern «Bestillinger»
end
dialogs.messages = {}
blocking(function() dofile(PLUGIN .. '/FotoCopyMenu.lua') end)
check(modalCount == 2, 'valgte kilde (to tjenester) og viste kopieringsvinduet')
local function childNamed(container, name, kind)
	for _, c in ipairs(container._children) do if c._name == name and (not kind or c._kind == kind) then return c end end
end
local fPort = childNamed(foto, 'Portefølje', 'LrPublishedCollectionSet')
local fNatur = fPort and childNamed(fPort, 'Natur')
local fKunde = fPort and childNamed(fPort, 'Kunde X')
local fBeste = fPort and childNamed(fPort, 'Beste')
local fPriv = childNamed(foto, 'Privat', 'LrPublishedCollectionSet')
local fFamilie = fPriv and childNamed(fPriv, 'Familie')
local fDiverse = childNamed(foto, 'Diverse')
check(fPort and fPort._settings.visibility == 'public', 'mappe «Portefølje» offentlig')
check(fNatur and fNatur._settings.visibility == 'public' and #fNatur._photos == 2 and fNatur._settings.allowDownload == false, 'album «Natur»: offentlig, 2 bilder, ingen nedlasting')
check(fKunde and fKunde._settings.visibility == 'private', 'album «Kunde X» (Unlisted) ble privat')
check(fBeste and fBeste._smart and fBeste._search[1].criteria == 'rating', 'smart album «Beste» med samme søk')
check(fPriv and fPriv._settings.visibility == 'private' and fFamilie and fFamilie._settings.visibility == 'private', 'privat mappe og album med ukjent synlighet ble private')
check(fDiverse and fDiverse._settings.visibility == 'public' and #fDiverse._photos == 1, 'album «Diverse» offentlig')
check(childNamed(foto, 'Bestillinger') == nil, '«Bestillinger» ble ikke tatt med')
local done = dialogs.messages[#dialogs.messages]
check(done and done.msg == 'Kopiert til Foto' and done.info:find('2 mapper og 5 album', 1, true) and done.info:find('1 mappe eller album hadde ukjent synlighet', 1, true), 'oppsummering: ' .. tostring(done and done.info))
-- Kjør på nytt med et nytt bilde i «Natur»
table.insert(sNatur._photos, sp[6])
fNatur._settings.visibility = 'private' -- brukeren har endret i Foto; skal ikke overskrives
dialogs.messages = {}
blocking(function() dofile(PLUGIN .. '/FotoCopyMenu.lua') end)
check(#fNatur._photos == 3 and fNatur._settings.visibility == 'private', 'ny kjøring: nytt bilde lagt til, innstillinger urørt')
local n = 0
for _, c in ipairs(fPort._children) do if c._name == 'Natur' then n = n + 1 end end
check(n == 1, 'ingen duplikater')
done = dialogs.messages[#dialogs.messages]
check(done and done.info:find('0 mapper og 0 album', 1, true), 'oppsummering ved ny kjøring: ' .. tostring(done and done.info))

print('18. Plugin-behandling og logg')
local info = require 'FotoInfoProvider'
local isections = blocking(info.sectionsForTopOfDialog, factory, propertyTable())
local logButton = find(isections, function(t) return t._kind == 'push_button' end)
blocking(logButton.action)
local logPath = TMP .. '/home/Library/Logs/Foto-Lightroom.log'
check(revealed == logPath, '«Vis loggfila» peker på ' .. tostring(revealed))
local log = __read(logPath) or ''
check(log:find('Publiserer', 1, true) and log:find('Kopiert:', 1, true), 'loggen har publisering og kopiering')
check(not log:find(TOKEN, 1, true), 'API-nøkkelen står ikke i loggen')

print('19. JSON')
local s = JSON.encode({ a = 'æøå "sitat" \n ny linje', b = { 1, 2, 3 }, c = true, d = 1.5, e = JSON.array({}) })
local back = JSON.decode(s)
check(back.a == 'æøå "sitat" \n ny linje' and back.b[3] == 3 and back.c == true and back.d == 1.5, 'tur-retur')

print('19b. Video')
-- Egen funksjon: hovedfila er nær grensen på 200 lokale variabler.
;(function()
	check(provider.canExportVideo == true, 'tjenesten kan eksportere video')
	local hidesVideo = false
	for _, n in ipairs(provider.hideSections) do if n == 'video' then hidesVideo = true end end
	check(hidesVideo, 'videoinnstillingene i Lightroom er skjult (pluginen bestemmer)')
	local es = {}
	blocking(provider.updateExportSettings, es)
	check(es.LR_includeVideoFiles == true and es.LR_export_videoFileHandling == 'include', 'videoer tas alltid med')
	check(es.LR_export_videoFormat == H264 and es.LR_export_videoPreset == 'h264-max', 'H.264 i beste kvalitet («Maks»)')
	videoPresetsFail = true
	local es2 = { LR_export_videoFormat = 'original' }
	blocking(provider.updateExportSettings, es2)
	videoPresetsFail = false
	check(es2.LR_export_videoFormat == H264 and es2.LR_export_videoPreset == 'original', 'uten SDK-et: H.264 med verdiene Lightroom selv lagrer')

	local colFilm = mkObj('LrPublishedCollection', 'Film', nil, foto, { _settings = { visibility = 'public', allowDownload = true } })
	FotoAPI.CHUNK = 96 * 1024
	local logBefore = #httpLog
	local vids = { { file = 'klipp.mp4', lrId = 70, video = true, taken = '2026-09-14T10:22:31', meta = { title = 'Til kai', caption = 'Ankomst' } } }
	check(publish(colFilm, vids), 'eksportfila er slettet etterpå')
	check(vids[1].newId and not vids[1].failed, 'videoen er lastet opp' .. (vids[1].failed and (': ' .. vids[1].failed) or ''))
	local vrow = vids[1].newId and one("SELECT * FROM photos WHERE id = '" .. vids[1].newId .. "'") or {}
	check(vrow.kind == 'video' and vrow.mime == 'video/mp4' and vrow.title == 'Til kai' and vrow.caption == 'Ankomst', 'lagret som video, med tittel og bildetekst')
	check(vrow.taken_at == 1789381351000, 'opptakstiden fra Lightroom er med (' .. tostring(vrow.taken_at) .. ')')
	check(vrow.sha256 == __sha256(IMG .. '/klipp.mp4'), 'fila kom fram uendret')
	local puts = 0
	for i = logBefore + 1, #httpLog do if httpLog[i]:find('^PUT /api/v1/uploads/') then puts = puts + 1 end end
	check(puts >= 3, 'sendt i biter (' .. puts .. ' biter)')

	local buggy = { { file = 'klipp.mp4', lrId = 71, video = true, bug = true } }
	publish(colFilm, buggy)
	check(buggy[1].newId and not buggy[1].failed, 'Lightroom-feilen («false, nil» for video) går fint')

	local again = { { file = 'klipp.mp4', lrId = 70, video = true, publishedId = vids[1].newId } }
	publish(colFilm, again)
	check(again[1].newId == vids[1].newId and one("SELECT version FROM photos WHERE id = '" .. vids[1].newId .. "'").version == 2, 'ny versjon av videoen: samme ID, versjon 2')
	local goneVideo = { { file = 'klipp.mp4', lrId = 72, video = true, publishedId = 'finnesikkevideo' } }
	publish(colFilm, goneVideo)
	check(goneVideo[1].newId and goneVideo[1].newId ~= 'finnesikkevideo', 'video som er slettet på nettstedet, lastes opp som ny')

	httpFaults[#httpFaults + 1] = { pattern = 'PUT /api/v1/uploads/', errorCode = 'timedOut' }
	httpFaults[#httpFaults + 1] = { pattern = '/complete', status = 503 }
	local flaky = { { file = 'klipp.mp4', lrId = 73, video = true } }
	publish(colFilm, flaky)
	check(flaky[1].newId and not flaky[1].failed and #httpFaults == 0, 'en bit som feiler og en server som starter på nytt: prøves igjen')
	check(one("SELECT count(*) AS n FROM photos WHERE album_id = (SELECT album_id FROM photos WHERE id = '" .. flaky[1].newId .. "')").n == 4, 'ingen dobbel video i albumet')

	-- Store filer lastes også ned i biter (Synkroniser med Foto).
	local apiV = FotoAPI.new(settings)
	local target = TMP .. '/nedlastet-klipp.mp4'
	local bytes = one("SELECT bytes FROM photos WHERE id = '" .. vids[1].newId .. "'").bytes
	logBefore = #httpLog
	local got = task(function() return apiV:download(vids[1].newId, target, bytes) end)
	local gets = 0
	for i = logBefore + 1, #httpLog do if httpLog[i]:find('GET /download/photo/', 1, true) then gets = gets + 1 end end
	check(got == bytes and __size(target) == bytes and __sha256(target) == __sha256(IMG .. '/klipp.mp4') and gets >= 3, 'stor fil lastet ned i ' .. gets .. ' biter, uendret')
	FotoAPI.CHUNK = 32 * 1024 * 1024
end)()

print('20. Synkroniser med Foto')
;(function()
local Sync = require 'FotoSync'
check(Sync.wallOf('2026-10-07T14:30:05.50+02:00') == '2026-10-07T14:30:05' and Sync.wallOf(nil) == nil, 'opptakstid som veggklokke')
check(Sync.stemOf('/Bilder/ED1_0590.NEF') == 'ed1_0590' and Sync.stemOf('a.b.JPG') == 'a.b', 'filnavn uten endelse')
check(Sync.safeName('A/B: «C»?') == 'A-B- «C»-' and Sync.safeName(' ..') == 'uten-navn', 'trygge mappenavn: ' .. Sync.safeName('A/B: «C»?'))
check(#Sync.safeName(string.rep('æ', 80)) <= 100 and Sync.safeName(string.rep('æ', 80)):match('^[\195][\166]') ~= nil, 'lange navn kuttes uten å ødelegge æøå')

local function urlenc(v)
	return (tostring(v or ''):gsub('[^%w%-%._~]', function(c) return string.format('%%%02X', string.byte(c)) end))
end
local function form(t)
	local parts = {}
	for k, v in pairs(t) do parts[#parts + 1] = urlenc(k) .. '=' .. urlenc(v) end
	table.sort(parts)
	return table.concat(parts, '&')
end
local AUTH = 'Authorization: Bearer ' .. TOKEN .. '\nAccept: application/json'
-- «Nettstedet»: det du gjør i admin, som innlogget administrator.
local function webCreate(kind, name, parentId, visibility, allowDownload)
	local f = { type = kind, name = name, parentId = parentId or '', visibility = visibility or 'public' }
	if allowDownload then f.allowDownload = 'on' end
	local st = __browser('POST', SERVER .. '/admin?/create', true, form(f))
	local row = one("SELECT * FROM nodes WHERE name = '" .. name .. "' AND lr_ref IS NULL ORDER BY created_at DESC")
	check(st == 200 and row, 'nettstedet: lagde ' .. kind .. ' «' .. name .. '» (' .. tostring(st) .. ')')
	return row
end
local function webSave(node, fields)
	local f = { name = fields.name or node.name, description = '', visibility = fields.visibility or node.visibility,
		parentId = fields.parentId or node.parent_id or '', allowDownloadField = '1' }
	if (fields.allowDownload == nil and node.allow_download == 1) or fields.allowDownload then f.allowDownload = 'on' end
	return __browser('POST', SERVER .. '/admin/node/' .. node.id .. '?/save', true, form(f))
end
local function webUpload(albumId, file, name)
	local body, status = __http('POST', SERVER .. '/api/v1/albums/' .. albumId .. '/photos', AUTH, nil,
		JSON.encode({ { name = 'file', filePath = IMG .. '/' .. file, fileName = name, contentType = 'image/jpeg' } }))
	local data = status == 201 and JSON.decode(body) or {}
	check(status == 201 and data.id, 'nettstedet: lastet opp «' .. name .. '» (' .. tostring(status) .. ')')
	return data.id
end
local function childNamed2(container, name, kind)
	for _, c in ipairs(container._children) do
		if c._name == name and (not kind or c._kind == kind) then return c end
	end
end
local function publishedAs(col)
	local out = {}
	for ph, e in pairs(col._published or {}) do out[e.remoteId] = ph end
	return out
end
local function publishTo(svc, svcSettings, collection, photos)
	local renditions = {}
	for i, p in ipairs(photos) do
		local path = TMP .. '/render2-' .. i .. '-' .. p.file
		__copy(IMG .. '/' .. p.file, path)
		renditions[i] = {
			photo = photo(p.lrId, p.meta or {}),
			publishedPhotoId = p.publishedId,
			waitForRender = function() return true, path end,
			recordPublishedPhotoId = function(_, id) p.newId = id end,
			recordPublishedPhotoUrl = function(_, url) p.url = url end,
			uploadFailed = function(_, msg) p.failed = msg end,
		}
	end
	local session = {
		countRenditions = function() return #renditions end,
		recordRemoteCollectionId = function(_, id) collection._remoteId = id end,
		recordRemoteCollectionUrl = function(_, url) collection._remoteUrl = url end,
	}
	task(provider.processRenderedPhotos, {}, {
		exportSession = session,
		propertyTable = svcSettings,
		publishedCollection = collection,
		publishService = svc,
		configureProgress = function()
			return { setPortionComplete = function() end, isCanceled = function() return false end, done = function() end }
		end,
		renditions = function()
			local i = 0
			return function() i = i + 1 if renditions[i] then return i, renditions[i] end end
		end,
	})
	-- Som Lightroom: bildene ligger i samlingen og er merket publisert.
	collection._published = collection._published or {}
	for i, p in ipairs(photos) do
		local ph = renditions[i].photo
		if p.newId then
			local member = false
			for _, q in ipairs(collection._photos) do if q == ph then member = true end end
			if not member then table.insert(collection._photos, ph) end
			collection._published[ph] = { photo = ph, remoteId = p.newId, url = p.url }
		end
	end
end

-- Egen Foto-tjeneste (egen serviceKey), så det som ble publisert over regnes som «en annen katalog».
local settings2 = propertyTable()
settings2.serverUrl, settings2.apiToken, settings2.serviceKey, settings2.siteName = SERVER, TOKEN, 'synktest01', '127.0.0.1'
local foto2 = service('Foto: synk', 'net.dalhus.foto')
foto2._publishSettings = settings2
local otherCount = one("SELECT count(*) AS n FROM nodes WHERE lr_ref LIKE 'lr:" .. settings.serviceKey .. ":%'").n
local otherRefsBefore = __sql("SELECT id, lr_ref FROM nodes WHERE lr_ref LIKE 'lr:" .. settings.serviceKey .. ":%' ORDER BY id")

-- Lightroom: et album som er publisert herfra, og et upublisert album med samme navn som et album på nettstedet.
local colEgen = mkObj('LrPublishedCollection', 'Egen', nil, foto2, { _settings = { visibility = 'public', allowDownload = false } })
local pe = { { file = 'lite-med-exif.jpg', lrId = 201 }, { file = 'rotert-orientation6.jpg', lrId = 202 } }
publishTo(foto2, settings2, colEgen, pe)
local egen = one("SELECT * FROM nodes WHERE lr_ref = 'lr:synktest01:col:" .. colEgen._id .. "'")
check(egen and pe[1].newId and pe[2].newId, 'publiserte «Egen» fra Lightroom')
local colTvilling = mkObj('LrPublishedCollection', 'tvilling', nil, foto2, { _settings = { visibility = 'public' } })
-- Katalogen: originalen til «match.jpg» (pluss en virtuell kopi og en med samme navn fra et annet år), og «uten-dato.jpg».
local pMatch = catalogPhoto(301, { path = '/Bilder/2026/match.NEF', dateTimeOriginalISO8601 = '2026-10-07T14:30:05.00+02:00', isVirtualCopy = false })
catalogPhoto(302, { path = '/Bilder/2026/match.NEF', dateTimeOriginalISO8601 = '2026-10-07T14:30:05.00+02:00', isVirtualCopy = true })
catalogPhoto(303, { path = '/Bilder/2025/match.NEF', dateTimeOriginalISO8601 = '2025-01-01T10:00:00' })
local pUtenDato = catalogPhoto(304, { path = '/Bilder/uten-dato.jpg', isVirtualCopy = false })

-- Nettstedet: ny mappe med album og bilder, nytt album på toppnivå, «Tvilling», og endringer på «Egen».
local gc = webCreate('folder', 'Kaikanten Terminal', nil, 'private')
local bef = webCreate('album', 'Befaring', gc.id, 'public')
local idMatch = webUpload(bef.id, 'lite-med-exif.jpg', 'match.jpg')
local idBare = webUpload(bef.id, 'rotert-orientation6.jpg', 'bare-paa-nett.jpg')
local idUtenDato = webUpload(bef.id, 'rotert-orientation6.jpg', 'uten-dato.jpg')
local web = webCreate('album', 'Webalbum', nil, 'public', true)
local idNett2 = webUpload(web.id, 'lite-med-exif.jpg', 'nett2.jpg')
local tvilling = webCreate('album', 'Tvilling', nil, 'public')
local idEkstra = webUpload(egen.id, 'lite-med-exif.jpg', 'ekstra.jpg')
local stDel = __http('DELETE', SERVER .. '/api/v1/photos/' .. pe[2].newId, AUTH, nil, nil)
local stSave = webSave(egen, { name = 'Egen (nytt navn)', visibility = 'private', parentId = gc.id })
check(stSave == 200 and one("SELECT name FROM nodes WHERE id = '" .. egen.id .. "'").name == 'Egen (nytt navn)', 'nettstedet: «Egen» fikk nytt navn, ble privat og flyttet')
local photosApi = JSON.decode((__http('GET', SERVER .. '/api/v1/albums/' .. bef.id .. '/photos', AUTH, nil, nil)))
check(photosApi.photos[1].takenAt == '2026-10-07T14:30:05' and photosApi.photos[2].takenAt == nil and photosApi.photos[1].filename == 'match.jpg',
	'API: bildene med filnavn og opptakstid som veggklokke (' .. tostring(photosApi.photos[1].takenAt) .. ')')

-- Kjør «Synkroniser med Foto» slik den startes fra menyen.
local syncModals, syncTexts = {}, {}
local function runSync(choice)
	syncModals, syncTexts = {}, {}
	dialogs.messages = {}
	dialogs.modalHook = function(args)
		syncModals[#syncModals + 1] = args
		local props = args.contents.bind_to_object
		if args.actionVerb == 'Fortsett' then
			local menu = find(args.contents, function(t) return t._kind == 'popup_menu' end)
			for _, item in ipairs(menu.items) do if item.title == 'Foto: synk' then props.service = item.value end end
		elseif args.actionVerb == 'Synkroniser' then
			find(args.contents, function(t)
				if type(t.title) == 'string' then syncTexts[#syncTexts + 1] = t.title end
				return false
			end)
			if os.getenv('VIS_DIALOG') then print('    [vindu] ' .. table.concat(syncTexts, '\n    [vindu] ')) end
			props.folder = TMP .. '/synk'
			props.download = choice.download ~= false
			props.remove = choice.remove == true
		end
	end
	blocking(function() dofile(PLUGIN .. '/FotoSyncMenu.lua') end)
	dialogs.modalHook = nil
	return dialogs.messages[#dialogs.messages]
end
local function textHas(pattern)
	for _, t in ipairs(syncTexts) do if t:find(pattern, 1, true) then return true end end
	return false
end

local done1 = runSync({ download = true, remove = true })
check(#syncModals == 2, 'valgte tjeneste og viste oversikten før noe ble endret (' .. #syncModals .. ' vinduer)')
check(textHas('Nytt fra nettstedet: 1 mappe og 2 album'), 'oversikt: 1 ny mappe og 2 nye album')
check(textHas('Kobles til den med samme navn i Lightroom: «Tvilling»'), 'oversikt: «Tvilling» kobles til albumet med samme navn')
check(textHas('2 nye navn') and textHas('1 flyttet') and textHas('1 ny synlighet'), 'oversikt: endret på nettstedet')
check(textHas('2 nye bilder på nettstedet finnes i katalogen'), 'oversikt: 2 bilder finnes i katalogen')
check(textHas('Last ned og importer 3 bilder som bare finnes på nettstedet'), 'oversikt: 3 bilder kan lastes ned')
check(textHas('Fjern fra Lightroom det som er slettet på nettstedet (1 bilde)'), 'oversikt: 1 bilde slettet på nettstedet')
check(textHas(otherCount .. ' mapper og album hører til en annen Lightroom-katalog'), 'oversikt: ' .. otherCount .. ' hører til en annen katalog')

local gcSet = childNamed2(foto2, 'Kaikanten Terminal', 'LrPublishedCollectionSet')
local befCol = gcSet and childNamed2(gcSet, 'Befaring', 'LrPublishedCollection')
local webCol = childNamed2(foto2, 'Webalbum', 'LrPublishedCollection')
check(gcSet and gcSet._settings.visibility == 'private' and gcSet._remoteId == gc.id and tostring(gcSet._remoteUrl):find('/a/' .. gc.id, 1, true),
	'Lightroom: mappa «Kaikanten Terminal» (privat, koblet til nettstedet)')
check(befCol and befCol._remoteId == bef.id and befCol._settings.visibility == 'public', 'Lightroom: albumet «Befaring» i mappa')
check(webCol and webCol._settings.allowDownload == true and webCol._remoteId == web.id, 'Lightroom: «Webalbum» med nedlasting på')
local refOf = function(id) return one("SELECT lr_ref FROM nodes WHERE id = '" .. id .. "'").lr_ref end
check(gcSet and refOf(gc.id) == 'lr:synktest01:set:' .. gcSet._id, 'nettstedet: mappa er koblet til Lightroom')
check(befCol and refOf(bef.id) == 'lr:synktest01:col:' .. befCol._id and webCol and refOf(web.id) == 'lr:synktest01:col:' .. webCol._id, 'nettstedet: albumene er koblet til Lightroom')
check(refOf(tvilling.id) == 'lr:synktest01:col:' .. colTvilling._id and colTvilling._remoteId == tvilling.id and colTvilling._name == 'Tvilling',
	'«tvilling» i Lightroom ble koblet til «Tvilling» (ingen kopi) og fikk samme skrivemåte')
local n2 = 0
for _, c in ipairs(foto2._children) do if c._name:lower() == 'tvilling' then n2 = n2 + 1 end end
check(n2 == 1, 'bare ett «Tvilling» i Lightroom')

local bp = befCol and publishedAs(befCol) or {}
check(bp[idMatch] == pMatch, '«match.jpg» koblet til originalen i katalogen (ikke den virtuelle kopien eller fjorårets)')
check(bp[idUtenDato] == pUtenDato, '«uten-dato.jpg» koblet til bildet med samme filnavn')
local barePath = TMP .. '/synk/Kaikanten Terminal/Befaring/bare-paa-nett.jpg'
check(bp[idBare] and bp[idBare]._raw.path == barePath, '«bare-paa-nett.jpg» lastet ned og importert til ' .. barePath)
check(__size(barePath) == __size(IMG .. '/rotert-orientation6.jpg') and not __exists(barePath .. '.part'), 'nedlastet fil er hel (samme størrelse som originalen)')
check(befCol and befCol._photos[1] == pMatch and befCol._photos[2] == bp[idBare] and befCol._photos[3] == pUtenDato, 'samme rekkefølge som på nettstedet')
local wp = webCol and publishedAs(webCol) or {}
check(wp[idNett2] and wp[idNett2]._raw.path == TMP .. '/synk/Webalbum/nett2.jpg', '«nett2.jpg» lastet ned til Webalbum')
local ep = publishedAs(colEgen)
check(colEgen._name == 'Egen (nytt navn)' and colEgen._parent == gcSet and colEgen._settings.visibility == 'private', '«Egen» fikk nytt navn, ble flyttet og privat i Lightroom')
check(ep[pe[1].newId] and not ep[pe[2].newId], 'bildet som ble slettet på nettstedet, er fjernet fra «Egen»')
check(ep[idEkstra] and ep[idEkstra]._raw.path == TMP .. '/synk/Kaikanten Terminal/Egen (nytt navn)/ekstra.jpg', '«ekstra.jpg» lastet ned til «Egen»')
check(#importedPaths == 3, '3 bilder importert i katalogen (' .. #importedPaths .. ')')
check(__sql("SELECT id, lr_ref FROM nodes WHERE lr_ref LIKE 'lr:" .. settings.serviceKey .. ":%' ORDER BY id") == otherRefsBefore, 'den andre katalogens album er urørt')
check(done1 and done1.msg == 'Synkronisert med Foto' and done1.info:find('Laget i Lightroom: 1 ny mappe og 2 nye album.', 1, true)
	and done1.info:find('5 bilder fra nettstedet ligger nå i albumene (2 fantes i katalogen og 3 ble lastet ned og importert).', 1, true)
	and done1.info:find('Fjernet fra Lightroom: 1 bilde.', 1, true), 'oppsummering: ' .. tostring(done1 and done1.info))
check(prefs.syncFolder == TMP .. '/synk', 'mappa for nedlastinger huskes')

-- Publiser fra Lightroom i albumet som ble laget på nettstedet: havner i samme album.
local pb = { { file = 'lite-med-exif.jpg', lrId = 210 } }
publishTo(foto2, settings2, befCol, pb)
check(pb[1].newId and one("SELECT album_id FROM photos WHERE id = '" .. pb[1].newId .. "'").album_id == bef.id, 'publisert fra Lightroom til «Befaring» på nettstedet')
check(one("SELECT count(*) AS n FROM nodes WHERE name = 'Befaring'").n == 1 and one("SELECT count(*) AS n FROM nodes WHERE name = 'Kaikanten Terminal'").n == 1, 'ingen nye kopier av mappa eller albumet')

-- Slettet album på nettstedet, og en kobling som ikke kommer fram (lagres ved neste publisering).
__browser('POST', SERVER .. '/admin/node/' .. web.id .. '?/delete', true, '')
local halv = webCreate('album', 'Halvveis', nil, 'public')
-- Samme bilde slettet og lastet opp på nytt på nettstedet: kobles til bildet i katalogen igjen (ingen kopi).
__http('DELETE', SERVER .. '/api/v1/photos/' .. idMatch, AUTH, nil, nil)
local idMatch2 = webUpload(bef.id, 'lite-med-exif.jpg', 'match.jpg')
local importsBefore = #importedPaths
httpFaults[#httpFaults + 1] = { pattern = 'POST /api/v1/lr/link', status = 500 }
local done2 = runSync({ download = true, remove = true })
local bp2 = publishedAs(befCol)
local stillMember = false
for _, q in ipairs(befCol._photos) do if q == pMatch then stillMember = true end end
check(bp2[idMatch2] == pMatch and bp2[idMatch] == nil and stillMember and #importedPaths == importsBefore,
	'samme bilde lastet opp på nytt: koblet til originalen igjen, ikke lastet ned som kopi')
check(childNamed2(foto2, 'Webalbum') == nil, '«Webalbum» som ble slettet på nettstedet, er fjernet fra Lightroom')
check(__exists(TMP .. '/synk/Webalbum/nett2.jpg'), 'det nedlastede bildet ligger igjen på disken')
local halvCol = childNamed2(foto2, 'Halvveis', 'LrPublishedCollection')
check(halvCol and halvCol._remoteId == halv.id and refOf(halv.id) == nil, '«Halvveis» laget i Lightroom; koblingen kom ikke fram')
check(done2 and done2.msg == 'Synkronisert, med noen unntak' and done2.info:find('ble ikke lagret', 1, true), 'feilen vises: ' .. tostring(done2 and done2.info))
local ph = { { file = 'lite-med-exif.jpg', lrId = 211 } }
publishTo(foto2, settings2, halvCol, ph)
check(refOf(halv.id) == 'lr:synktest01:col:' .. halvCol._id and one("SELECT album_id FROM photos WHERE id = '" .. ph[1].newId .. "'").album_id == halv.id,
	'publisering koblet «Halvveis» likevel (ingen kopi på nettstedet)')
check(one("SELECT count(*) AS n FROM nodes WHERE name = 'Halvveis'").n == 1, 'bare én «Halvveis» på nettstedet')

local done3 = runSync({})
check(#syncModals == 1 and done3 and done3.msg == 'Alt er likt', 'tredje gang: alt er likt (' .. tostring(done3 and done3.msg) .. ')')

-- Koblingsreglene på serveren.
local api2 = FotoAPI.new(settings2)
local anOther = JSON.decode(otherRefsBefore)[1]
local res = task(function()
	return api2:link('synktest01', {
		{ id = anOther.id, kind = 'album', lrId = 99999 },
		{ id = 'finnesikke12', kind = 'album', lrId = 99998 },
		{ id = halv.id, kind = 'folder', lrId = 99997 },
		{ id = halv.id, kind = 'album', lrId = 99996 },
	})
end)
check(res[1].ok == false and (tostring(res[1].error):find('annen Lightroom-katalog', 1, true) or tostring(res[1].error):find('mappe på nettstedet', 1, true)), 'kan ikke ta over noe fra en annen katalog: ' .. tostring(res[1].error))
check(res[2].ok == false and tostring(res[2].error):find('Finnes ikke', 1, true), 'ukjent ID: ' .. tostring(res[2].error))
check(res[3].ok == false and tostring(res[3].error):find('er et album', 1, true), 'feil type: ' .. tostring(res[3].error))
check(res[4].ok == false and tostring(res[4].error):find('allerede koblet', 1, true), 'allerede koblet til en annen samling: ' .. tostring(res[4].error))
check(refOf(halv.id) == 'lr:synktest01:col:' .. halvCol._id, 'koblingen er uendret')

-- Uten lagret nøkkel stopper synkroniseringen før noe endres.
settings2.serviceKey = ''
local nodesBefore = __sql('SELECT id, lr_ref FROM nodes ORDER BY id')
local stop = runSync({})
check(#syncModals == 1 and stop and stop.msg == 'Lagre Foto-innstillingene én gang først' and __sql('SELECT id, lr_ref FROM nodes ORDER BY id') == nodesBefore,
	'uten nøkkel: stopper og ber deg lagre innstillingene')
settings2.serviceKey = 'synktest01'
end)()

print('')
if #violations > 0 then
	print('BRUDD PÅ LIGHTROOM-REGLER: ' .. #violations)
	for _, v in ipairs(violations) do print('  - ' .. v) end
end
print(string.format('RESULTAT: %d feil, %d regelbrudd', failures, #violations))
if failures > 0 or #violations > 0 then error('testen feilet', 0) end
