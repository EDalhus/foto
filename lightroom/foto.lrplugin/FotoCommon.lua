--[[
	Felles hjelpere for publiseringstjenesten (FotoServiceProvider) og «Synkroniser med Foto» (FotoSync).

	NB: kall som leser katalogen kan «yielde». Pakk dem i LrTasks.pcall, aldri i vanlig pcall.
]]

local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'

local FotoAPI = require 'FotoAPI'
local JSON = require 'FotoJSON'

local Common = {}

--- Nøkkel som skiller denne publiseringstjenesten fra andre (f.eks. flere kataloger).
function Common.serviceKeyOf(settings, publishService)
	local key = settings and settings.serviceKey
	if key and key ~= '' then return key end
	if publishService and publishService.localIdentifier then
		return 'svc' .. tostring(publishService.localIdentifier)
	end
	return 'standard'
end

function Common.isSet(obj)
	if obj == nil then return false end
	local ok, t = pcall(function() return obj:type() end)
	if ok and type(t) == 'string' then return t == 'LrPublishedCollectionSet' end
	return obj.getPublishedPhotos == nil
end

function Common.nameOf(obj)
	local ok, name = LrTasks.pcall(function() return obj:getName() end)
	return ok and tostring(name) or '?'
end

--- Vår ID (album/mappe på nettstedet) slik Lightroom har lagret den på samlingen, eller nil.
function Common.remoteIdOf(obj)
	if obj == nil then return nil end
	local ok, id = LrTasks.pcall(function() return obj:getRemoteId() end)
	if ok and id ~= nil and id ~= '' then return tostring(id) end
	return nil
end

--- Innstillingene (synlighet, nedlasting) som er lagret på et album eller en mappe i Lightroom.
--- Kaster feil hvis de ikke kan leses – da er det tryggere å stoppe enn å gjette «offentlig».
function Common.settingsOf(obj)
	local ok, summary = LrTasks.pcall(function()
		if Common.isSet(obj) then return obj:getCollectionSetInfoSummary() end
		return obj:getCollectionInfoSummary()
	end)
	if not ok then
		error('Kunne ikke lese innstillingene for «' .. Common.nameOf(obj) .. '» i Lightroom: ' .. FotoAPI.messageOf(summary), 0)
	end
	if type(summary) == 'table' and type(summary.collectionSettings) == 'table' then
		return summary.collectionSettings
	end
	return {}
end

function Common.visibilityOf(settings)
	if settings and settings.visibility == 'private' then return 'private' end
	return 'public'
end

function Common.parentEntry(set)
	return {
		lrId = set.localIdentifier,
		name = set:getName(),
		visibility = Common.visibilityOf(Common.settingsOf(set)),
		remoteId = Common.remoteIdOf(set),
	}
end

--- Mappene over et album/en mappe, fra toppnivå og nedover, med synlighet.
function Common.ancestry(obj)
	local parents = JSON.array({})
	local parent = obj:getParent()
	local guard = 0
	while parent and Common.isSet(parent) and guard < 50 do
		table.insert(parents, 1, Common.parentEntry(parent))
		parent = parent:getParent()
		guard = guard + 1
	end
	return parents
end

-- Innstillinger som ikke kom fram til nettstedet (f.eks. endret uten nett) -----
-- Lagres i pluginens innstillinger og sendes neste gang albumet (eller et album i mappa) publiseres.

local Pending = {}
Common.Pending = Pending

local function pendingKey(serviceKey, kind, lrId)
	return serviceKey .. ':' .. kind .. ':' .. tostring(lrId)
end

local function pendingRead()
	local raw = LrPrefs.prefsForPlugin().pendingSettings
	if type(raw) ~= 'string' or raw == '' then return {} end
	local ok, t = pcall(JSON.decode, raw)
	if ok and type(t) == 'table' then return t end
	return {}
end

local function pendingWrite(t)
	LrPrefs.prefsForPlugin().pendingSettings = next(t) ~= nil and JSON.encode(t) or ''
end

function Pending.has(serviceKey, kind, lrId)
	return pendingRead()[pendingKey(serviceKey, kind, lrId)] == true
end

function Pending.mark(serviceKey, kind, lrId)
	local t = pendingRead()
	t[pendingKey(serviceKey, kind, lrId)] = true
	pendingWrite(t)
end

function Pending.clear(serviceKey, kind, lrId)
	local t = pendingRead()
	local key = pendingKey(serviceKey, kind, lrId)
	if t[key] ~= nil then
		t[key] = nil
		pendingWrite(t)
	end
end

return Common
