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
		local content = __read(path)
		if content == nil then return nil, 'finnes ikke' end
		return { seek = function() return #content end, read = function() return content end, close = function() end }
	end
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
modules.LrFileUtils = { delete = function(p) __rm(p) return true end, exists = function(p) return __exists(p) and 'file' or false end }
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
local function create(service, kind, name, parent, canReturn, extra)
	needsGate('create ' .. kind)
	if canReturn then
		for _, c in ipairs((parent or service)._children) do
			if c._kind == kind and c._name == name then return c end
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
local function photo(id, meta)
	return setmetatable({ _id = id, _meta = meta or {} }, { __index = function(t, k)
		if k == 'localIdentifier' then return rawget(t, '_id') end
		if k == 'getFormattedMetadata' then
			return function(self, key) yields('getFormattedMetadata') return self._meta[key] end
		end
	end })
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
			photo = photo(p.lrId or i, p.meta),
			publishedPhotoId = p.publishedId,
			waitForRender = function() return true, path end,
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

print('')
if #violations > 0 then
	print('BRUDD PÅ LIGHTROOM-REGLER: ' .. #violations)
	for _, v in ipairs(violations) do print('  - ' .. v) end
end
print(string.format('RESULTAT: %d feil, %d regelbrudd', failures, #violations))
if failures > 0 or #violations > 0 then error('testen feilet', 0) end
