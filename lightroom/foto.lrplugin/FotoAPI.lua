--[[
	HTTP-kall mot Foto-serveren. Alle kall bruker API-nøkkelen som «Bearer»-token.
	Feil kastes som Lua-feil med en norsk melding som Lightroom viser til brukeren.

	Forbigående feil (serveren starter på nytt, nettet hikker) prøves på nytt et par ganger.
	Opplasting av nye bilder prøves bare på nytt når vi vet at serveren ikke fikk forespørselen,
	så et bilde aldri havner to ganger i albumet.

	Store filer (video) lastes opp i biter på 32 MB. Hver bit kan sendes på nytt uten skade, og serveren
	sier fra hvor langt den har kommet, så en nettfeil midt i en stor video koster bare én bit.
]]

local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrMD5 = import 'LrMD5'
local LrDate = import 'LrDate'
local LrTasks = import 'LrTasks'

local JSON = require 'FotoJSON'
local Log = require 'FotoLog'

local FotoAPI = {}
FotoAPI.__index = FotoAPI

--- Holdes lik VERSION i Info.lua. Sendes til serveren i X-Foto-Plugin.
FotoAPI.VERSION = '0.5.0'

local function trim(s)
	return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

--- Normaliser serveradressen: https:// foran, ingen skråstrek bak.
function FotoAPI.normalizeUrl(url)
	local u = trim(url):gsub('/+$', '')
	if u ~= '' and not u:match('^https?://') then u = 'https://' .. u end
	return u
end

--- Vertsnavnet i serveradressen, f.eks. «foto.dalhus.net».
function FotoAPI.hostOf(url)
	return FotoAPI.normalizeUrl(url):match('^https?://([^/:]+)') or ''
end

--- Tilfeldig nøkkel som skiller denne publiseringstjenesten fra andre (lagres i innstillingene).
function FotoAPI.randomKey()
	math.randomseed(math.floor((LrDate.currentTime() % 1) * 1e6) + math.floor(LrDate.currentTime()))
	local seed = tostring(LrDate.currentTime()) .. tostring(math.random()) .. tostring({})
	return string.sub(LrMD5.digest(seed), 1, 16)
end

--- Gjør en feil (fra pcall) om til en lesbar melding uten Lua-filnavn og linjenummer foran.
function FotoAPI.messageOf(err)
	if type(err) == 'table' then err = err.message or err.error or tostring(err) end
	local s = tostring(err or 'Ukjent feil')
	s = s:gsub('^%[string "[^"]*"%]:%d+: ', ''):gsub('^[%w_%.%-/ ]+%.lua:%d+: ', '')
	return s
end

function FotoAPI.new(settings)
	local base = FotoAPI.normalizeUrl(settings.serverUrl)
	if base == '' then
		error('Serveradressen mangler. Høyreklikk Foto under «Publiser tjenester» og velg «Rediger innstillinger…».', 0)
	end
	local token = trim(settings.apiToken)
	if token == '' then
		error('Lightroom er ikke koblet til Foto. Høyreklikk Foto under «Publiser tjenester», velg «Rediger innstillinger …» og trykk «Koble til Foto …».', 0)
	end
	return setmetatable({ base = base, token = token }, FotoAPI)
end

function FotoAPI:headers(extra)
	local h = {
		{ field = 'Authorization', value = 'Bearer ' .. self.token },
		{ field = 'Accept', value = 'application/json' },
		{ field = 'X-Foto-Plugin', value = FotoAPI.VERSION },
	}
	for _, x in ipairs(extra or {}) do h[#h + 1] = x end
	return h
end

-- Nye forsøk ------------------------------------------------------------------

local NETWORK_MESSAGES = {
	timedOut = 'serveren svarte ikke i tide',
	cannotFindHost = 'fant ikke serveren – sjekk adressen og nettforbindelsen',
	cannotConnectToHost = 'kom ikke i kontakt med serveren',
	networkConnectionLost = 'nettforbindelsen ble brutt',
	resourceUnavailable = 'serveren er ikke tilgjengelig',
	badServerResponse = 'serveren svarte med noe uventet',
	securityError = 'den sikre tilkoblingen (HTTPS) feilet',
	serverCertificateHasBadDate = 'sertifikatet til serveren er utløpt',
	serverCertificateHasUnknownRoot = 'sertifikatet til serveren er ukjent',
	badURL = 'serveradressen er ugyldig',
}

-- Forespørselen kom aldri fram til serveren: trygt å prøve igjen.
local NOT_SENT = { cannotFindHost = true, cannotConnectToHost = true }
-- Vi vet ikke om serveren rakk å behandle forespørselen: prøv igjen bare når kallet tåler å gjentas.
local MAYBE_SENT = { timedOut = true, networkConnectionLost = true, resourceUnavailable = true, badServerResponse = true }
-- 502/503: appen fikk ikke forespørselen (f.eks. mens den starter på nytt). 504: kanskje behandlet.
local STATUS_NOT_HANDLED = { [502] = true, [503] = true }
local STATUS_MAYBE_HANDLED = { [504] = true }

local DEFAULT_DELAYS = { 2, 5, 10 }

--- Kjører send() med nye forsøk ved forbigående feil. Returnerer (body, headers) fra siste forsøk.
--- opts.idempotent: kallet kan trygt gjentas. opts.delays: ventetider i sekunder ({} = ingen nye forsøk).
function FotoAPI:request(label, opts, send)
	local delays = opts.delays or DEFAULT_DELAYS
	local attempt = 0
	while true do
		attempt = attempt + 1
		local started = LrDate.currentTime()
		local body, headers = send()
		local ms = math.floor((LrDate.currentTime() - started) * 1000 + 0.5)
		local retry = false
		local netError = body == nil and type(headers) == 'table' and headers.error
		if netError then
			local code = tostring(netError.errorCode or '')
			Log.warn(label, 'nettverksfeil:', code, tostring(netError.name or ''), ms .. ' ms', 'forsøk ' .. attempt)
			retry = NOT_SENT[code] or (opts.idempotent and MAYBE_SENT[code]) or false
		else
			local status = type(headers) == 'table' and tonumber(headers.status) or 0
			if status >= 400 then
				Log.warn(label, status, ms .. ' ms', 'forsøk ' .. attempt)
			else
				Log.info(label, status, ms .. ' ms')
			end
			retry = STATUS_NOT_HANDLED[status] or (opts.idempotent and STATUS_MAYBE_HANDLED[status]) or false
		end
		if not retry or attempt > #delays then return body, headers end
		LrTasks.sleep(delays[attempt])
	end
end

--- Tolker svaret. Returnerer (data, status). Kaster feil hvis serveren ikke kunne nås.
local function parse(body, headers)
	if body == nil and type(headers) == 'table' and headers.error then
		local e = headers.error
		local reason = NETWORK_MESSAGES[e.errorCode] or tostring(e.name or e.errorCode or 'ukjent feil')
		error('Fikk ikke kontakt med Foto-serveren: ' .. reason .. '.', 0)
	end
	local status = type(headers) == 'table' and tonumber(headers.status) or 0
	local data
	if body and body ~= '' then
		local ok, decoded = pcall(JSON.decode, body)
		if ok then data = decoded end
	end
	return data, status
end

--- Kaster en lesbar feil hvis status ikke er 2xx.
local function ensure(data, status, what)
	if status >= 200 and status < 300 then return data end
	local reason = (type(data) == 'table' and data.error) or ('serveren svarte ' .. tostring(status))
	if status == 401 then reason = 'Lightroom er ikke lenger koblet til nettstedet. Høyreklikk Foto under «Publiser tjenester», velg «Rediger innstillinger …» og trykk «Koble til Foto …» på nytt'
	elseif status == 413 then reason = 'fila er for stor for serveren'
	elseif status == 502 or status == 503 then reason = 'serveren er midlertidig utilgjengelig – prøv igjen om litt'
	end
	error(what .. ': ' .. tostring(reason), 0)
end

function FotoAPI:get(path, opts)
	return parse(self:request('GET ' .. path, opts or { idempotent = true }, function()
		return LrHttp.get(self.base .. path, self:headers(), 30)
	end))
end

function FotoAPI:postJson(path, payload, opts)
	local body = JSON.encode(payload or {})
	opts = opts or { idempotent = true }
	return parse(self:request('POST ' .. path, opts, function()
		return LrHttp.post(
			self.base .. path,
			body,
			self:headers({ { field = 'Content-Type', value = 'application/json' } }),
			'POST',
			opts.timeout or 60
		)
	end))
end

local CONTENT_TYPES = {
	jpg = 'image/jpeg', jpeg = 'image/jpeg', png = 'image/png', tif = 'image/tiff', tiff = 'image/tiff',
	mp4 = 'video/mp4', m4v = 'video/mp4', mov = 'video/quicktime',
}

local function contentTypeOf(filePath)
	local ext = string.lower(tostring(filePath or ''):match('%.([%w]+)$') or '')
	return CONTENT_TYPES[ext] or 'application/octet-stream'
end

--- Laster opp en fil. onProgress(0..1) kalles underveis hvis Lightroom støtter det.
function FotoAPI:postFile(path, filePath, fields, opts, onProgress)
	local content = {
		{
			name = 'file',
			fileName = LrPathUtils.leafName(filePath),
			filePath = filePath,
			contentType = contentTypeOf(filePath),
		},
	}
	local names = {}
	for k in pairs(fields or {}) do names[#names + 1] = k end
	table.sort(names)
	for _, k in ipairs(names) do
		content[#content + 1] = { name = k, value = tostring(fields[k] or '') }
	end
	local callback
	if onProgress then
		callback = function(fraction) pcall(onProgress, tonumber(fraction) or 0) end
	end
	return parse(self:request('POST ' .. path, opts, function()
		return LrHttp.postMultipart(self.base .. path, content, self:headers(), 600, callback)
	end))
end

-- Koble til (uten nøkkel) ---------------------------------------------------------

--- Kall uten API-nøkkel, brukt mens vi kobler til. Returnerer (data, status).
local function connectCall(base, path, payload)
	local body = JSON.encode(payload)
	local headers = {
		{ field = 'Accept', value = 'application/json' },
		{ field = 'Content-Type', value = 'application/json' },
		{ field = 'X-Foto-Plugin', value = FotoAPI.VERSION },
	}
	local started = LrDate.currentTime()
	local res, h = LrHttp.post(base .. path, body, headers, 'POST', 30)
	local data, status = parse(res, h)
	if status >= 400 then
		Log.warn('POST ' .. path, status, math.floor((LrDate.currentTime() - started) * 1000 + 0.5) .. ' ms')
	end
	return data, status
end

--- Starter tilkoblingen. Returnerer { pollSecret, code, url, interval, expiresIn }.
function FotoAPI.connectStart(serverUrl, device)
	local base = FotoAPI.normalizeUrl(serverUrl)
	if base == '' then error('Fyll inn serveradressen først.', 0) end
	local data, status = connectCall(base, '/api/v1/connect/start', { device = device })
	if status == 404 then error('Serveren støtter ikke «Koble til» ennå. Sjekk adressen, eller oppdater Foto-serveren.', 0) end
	data = ensure(data, status, 'Kunne ikke starte tilkoblingen')
	if type(data) ~= 'table' or type(data.pollSecret) ~= 'string' or type(data.url) ~= 'string' then
		error('Kunne ikke starte tilkoblingen: uventet svar fra serveren.', 0)
	end
	return data
end

--- Spør om tilkoblingen er godkjent. Returnerer { status = 'pending' | 'approved' | 'denied' | 'expired', token?, email? }.
function FotoAPI.connectPoll(serverUrl, pollSecret)
	local data, status = connectCall(FotoAPI.normalizeUrl(serverUrl), '/api/v1/connect/poll', { pollSecret = pollSecret })
	return ensure(data, status, 'Tilkoblingen feilet')
end

-- Endepunkter -----------------------------------------------------------------

--- Test tilkobling. Ingen nye forsøk – svaret skal komme med en gang.
function FotoAPI:me()
	local data, status = self:get('/api/v1/me', { idempotent = true, delays = {} })
	return ensure(data, status, 'Tilkoblingen feilet')
end

--- «Koble fra»: sletter nøkkelen vi bruker på nettstedet. Ingen nye forsøk.
function FotoAPI:revoke()
	local data, status = self:postJson('/api/v1/connect/revoke', {}, { idempotent = true, delays = {} })
	if status == 401 then return true end -- allerede trukket tilbake
	return ensure(data, status, 'Kunne ikke koble fra')
end

--- Finn/opprett mappe eller album.
--- payload: { serviceKey, kind, lrId, name, parents = { { lrId, name, visibility } }, visibility?, allowDownload?, applySettings? }
function FotoAPI:sync(payload)
	local data, status = self:postJson('/api/v1/lr/sync', payload)
	return ensure(data, status, 'Kunne ikke opprette/oppdatere «' .. tostring(payload.name) .. '» på nettstedet')
end

function FotoAPI:deleteCollection(payload)
	local data, status = self:postJson('/api/v1/lr/delete-collection', payload)
	return ensure(data, status, 'Kunne ikke slette på nettstedet')
end

function FotoAPI:uploadPhoto(albumId, filePath, meta, onProgress)
	local data, status = self:postFile('/api/v1/albums/' .. albumId .. '/photos', filePath, meta, { idempotent = false }, onProgress)
	return ensure(data, status, 'Opplastingen feilet')
end

--- Erstatter et publisert bilde. Returnerer nil hvis bildet ikke finnes på serveren lenger.
function FotoAPI:replacePhoto(photoId, filePath, meta, onProgress)
	local data, status = self:postFile('/api/v1/photos/' .. photoId .. '/replace', filePath, meta, { idempotent = true }, onProgress)
	if status == 404 then return nil end
	return ensure(data, status, 'Ny versjon feilet')
end

--- Bitstørrelse for store filer. Serveren kan be om mindre, aldri større.
FotoAPI.CHUNK = 32 * 1024 * 1024

--- Laster opp en stor fil (video) i biter. replaceId: ny versjon av et bilde/en video som finnes.
--- Returnerer { id, version, kind, url }, eller nil hvis replaceId ikke finnes på nettstedet lenger.
function FotoAPI:uploadLarge(albumId, filePath, meta, onProgress, replaceId)
	local attrs = LrFileUtils.fileAttributes(filePath)
	local size = attrs and tonumber(attrs.fileSize)
	if not size or size <= 0 then error('Fant ikke fila som skulle lastes opp: ' .. LrPathUtils.leafName(filePath), 0) end
	local payload = { albumId = albumId, filename = LrPathUtils.leafName(filePath), size = size, replaceId = replaceId }
	for k, v in pairs(meta or {}) do payload[k] = v end
	-- Å starte er trygt å gjenta: en opplasting som aldri brukes, rydder serveren bort.
	local start, status = self:postJson('/api/v1/uploads', payload)
	-- 404 uten feilmelding fra oss: serveren er eldre enn denne pluginen.
	if status == 404 and not (type(start) == 'table' and start.error) then
		error('Foto-serveren tar ikke imot video ennå. Oppdater Foto på serveren og publiser på nytt.', 0)
	end
	if status == 404 and replaceId then return nil end
	start = ensure(start, status, 'Opplastingen feilet')
	local id = tostring(start.id or '')
	if id == '' then error('Opplastingen feilet: serveren svarte uten ID.', 0) end
	local chunkSize = math.min(tonumber(start.chunkSize) or FotoAPI.CHUNK, FotoAPI.CHUNK)
	local offset = tonumber(start.received) or 0

	local f, err = io.open(filePath, 'rb')
	if not f then error('Kunne ikke lese fila: ' .. tostring(err), 0) end
	local ok, problem = LrTasks.pcall(function()
		local stuck = 0
		while offset < size do
			f:seek('set', offset)
			local chunk = f:read(math.min(chunkSize, size - offset))
			if type(chunk) ~= 'string' or #chunk == 0 then error('Kunne ikke lese fila (stopp ved byte ' .. offset .. ').', 0) end
			local at = offset
			local data, st = parse(self:request('PUT bit ' .. math.floor(at / chunkSize) + 1, { idempotent = true }, function()
				return LrHttp.post(
					self.base .. '/api/v1/uploads/' .. id .. '?offset=' .. at,
					chunk,
					self:headers({ { field = 'Content-Type', value = 'application/octet-stream' } }),
					'PUT',
					300
				)
			end))
			local received = type(data) == 'table' and tonumber(data.received) or nil
			if st == 409 and received then
				-- Serveren er et annet sted (en bit kom fram, men svaret ble borte – eller noe er i gang): fortsett derfra.
				if received == at then
					stuck = stuck + 1
					if stuck > 5 then ensure(data, st, 'Opplastingen feilet') end
					LrTasks.sleep(2)
				else
					stuck = 0
				end
				offset = received
			else
				data = ensure(data, st, 'Opplastingen feilet')
				offset = tonumber(data.received) or (at + #chunk)
				stuck = 0
			end
			if onProgress then pcall(onProgress, offset / size) end
		end
	end)
	f:close()
	if not ok then error(problem, 0) end
	-- Serveren lager stillbilde og miniatyrer før den svarer; for store videoer kan det ta litt tid.
	local done, st = self:postJson('/api/v1/uploads/' .. id .. '/complete', {}, { idempotent = true, timeout = 600 })
	if st == 404 and replaceId then return nil end
	return ensure(done, st, 'Opplastingen feilet')
end

function FotoAPI:deletePhotos(ids)
	local data, status = self:postJson('/api/v1/lr/delete-photos', { ids = JSON.array(ids) })
	return ensure(data, status, 'Kunne ikke slette bilder på nettstedet')
end

function FotoAPI:setOrder(albumId, photoIds)
	local data, status = self:postJson('/api/v1/albums/' .. albumId .. '/order', { photoIds = JSON.array(photoIds) })
	return ensure(data, status, 'Kunne ikke sette rekkefølgen på nettstedet')
end

-- «Synkroniser med Foto» -------------------------------------------------------

local function urlEncode(s)
	return (tostring(s or ''):gsub('[^%w%-%._~]', function(c) return string.format('%%%02X', string.byte(c)) end))
end

--- Hele strukturen på nettstedet: { nodes = { { id, type, name, parentId, visibility, allowDownload, url, path, link, photoIds? } } }.
--- link er nil (laget på nettstedet), 'other' (en annen Lightroom-katalog) eller { lrId } (denne tjenesten).
function FotoAPI:lrTree(serviceKey)
	local data, status = self:get('/api/v1/lr/tree?serviceKey=' .. urlEncode(serviceKey))
	if status == 404 then
		error('Foto-serveren kan ikke synkronisere ennå. Oppdater Foto på serveren og prøv igjen.', 0)
	end
	data = ensure(data, status, 'Kunne ikke hente mapper og album fra nettstedet')
	if type(data) ~= 'table' or type(data.nodes) ~= 'table' then error('Uventet svar fra nettstedet.', 0) end
	return data.nodes
end

--- Bildene i et album: { { id, filename, downloadName, takenAt, width, height, bytes, mime, url } }.
function FotoAPI:albumPhotos(albumId)
	local data, status = self:get('/api/v1/albums/' .. albumId .. '/photos')
	data = ensure(data, status, 'Kunne ikke hente bildene i albumet')
	if type(data) ~= 'table' or type(data.photos) ~= 'table' then error('Uventet svar fra nettstedet.', 0) end
	return data.photos
end

--- Kobler mapper/album på nettstedet til samlinger i Lightroom. links: { { id, kind, lrId, relink? } }.
--- Returnerer { { id, ok, error? } } i samme rekkefølge.
function FotoAPI:link(serviceKey, links)
	local data, status = self:postJson('/api/v1/lr/link', { serviceKey = serviceKey, links = JSON.array(links) })
	data = ensure(data, status, 'Kunne ikke koble til nettstedet')
	if type(data) ~= 'table' or type(data.results) ~= 'table' then error('Uventet svar fra nettstedet.', 0) end
	return data.results
end

--- Laster ned originalen til filePath (via en midlertidig fil, så en avbrutt nedlasting aldri ligger igjen
--- som et halvt bilde). expectedBytes: størrelsen nettstedet oppgir, eller nil. Store filer (video) hentes i biter.
function FotoAPI:download(photoId, filePath, expectedBytes)
	local path = '/download/photo/' .. photoId
	local total = tonumber(expectedBytes)
	local function get(range)
		local headers = {
			{ field = 'Authorization', value = 'Bearer ' .. self.token },
			{ field = 'X-Foto-Plugin', value = FotoAPI.VERSION },
		}
		if range then headers[#headers + 1] = { field = 'Range', value = range } end
		local body, h = self:request('GET ' .. path .. (range and (' ' .. range) or ''), { idempotent = true }, function()
			return LrHttp.get(self.base .. path, headers, 300)
		end)
		if body == nil and type(h) == 'table' and h.error then parse(body, h) end -- kaster en lesbar feil
		local status = type(h) == 'table' and tonumber(h.status) or 0
		if status ~= 200 and status ~= 206 then
			local data = nil
			if body and body:sub(1, 1) == '{' then
				local ok, decoded = pcall(JSON.decode, body)
				if ok then data = decoded end
			end
			ensure(data, status, 'Kunne ikke laste ned bildet')
		end
		if type(body) ~= 'string' or #body == 0 then error('Kunne ikke laste ned bildet: tomt svar.', 0) end
		return body, status
	end

	local part = filePath .. '.part'
	local f, err = io.open(part, 'wb')
	if not f then error('Kunne ikke lagre bildet: ' .. tostring(err), 0) end
	local written = 0
	local ok, problem = LrTasks.pcall(function()
		if total and total > FotoAPI.CHUNK then
			while written < total do
				local last = math.min(written + FotoAPI.CHUNK, total) - 1
				local body, status = get('bytes=' .. written .. '-' .. last)
				if status == 200 then
					-- Serveren sendte hele fila likevel.
					if written > 0 or #body ~= total then error('Kunne ikke laste ned bildet: uventet svar fra serveren.', 0) end
					f:write(body)
					written = #body
				else
					f:write(body)
					written = written + #body
				end
			end
		else
			local body = get(nil)
			f:write(body)
			written = #body
		end
	end)
	f:close()
	if not ok then
		LrFileUtils.delete(part)
		error(problem, 0)
	end
	if total and written ~= total then
		LrFileUtils.delete(part)
		error('Kunne ikke laste ned bildet: fikk ' .. written .. ' av ' .. tostring(expectedBytes) .. ' byte.', 0)
	end
	if LrFileUtils.exists(filePath) then LrFileUtils.delete(filePath) end
	local moved = LrFileUtils.move(part, filePath)
	if moved == false then error('Kunne ikke lagre bildet i ' .. filePath, 0) end
	return written
end

return FotoAPI
