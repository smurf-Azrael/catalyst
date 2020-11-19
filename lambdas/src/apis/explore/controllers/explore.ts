import { Request, Response } from "express";
import { DAOCache } from "../../../service/dao/DAOCache";
import { ServerMetadata } from "decentraland-katalyst-commons/ServerMetadata";
import { EntityType, Fetcher, Entity } from "dcl-catalyst-commons";
import { noReject } from "decentraland-katalyst-utils/util";
import { TimeRefreshedDataHolder } from "../../../utils/TimeRefreshedDataHolder";
import { SmartContentClient } from "../../../utils/SmartContentClient";
import ms from "ms";

type ParcelCoord = [number, number];

type RealmInfo = {
  serverName: string;
  layer: string;
  usersCount: number;
  usersMax: number;
  userParcels: ParcelCoord[];
};

export type HotSceneInfo = {
  id: string;
  name: string;
  baseCoords: ParcelCoord;
  usersTotalCount: number;
  parcels: ParcelCoord[];
  thumbnail?: string;
  projectId?: string;
  creator?: string;
  description?: string;
  realms: RealmInfo[];
};

type Layer = {
  name: string;
  usersCount: number;
  maxUsers: number;
  usersParcels: ParcelCoord[];
};

type ServerStatus = {
  name: string;
  url: string;
  layers: Layer[];
};

let realmsStatusCache: TimeRefreshedDataHolder<RealmInfo[]>;

export async function realmsStatus(daoCache: DAOCache, req: Request, res: Response) {
  // Method: GET
  // Path: /realms

  if (!realmsStatusCache) {
    realmsStatusCache = new TimeRefreshedDataHolder(() => fetchRealmsData(daoCache), ms("1m"));
  }

  const realmsStatusData = await realmsStatusCache.get();

  res.status(200).send(realmsStatusData);
}

let hotSceneCache: TimeRefreshedDataHolder<HotSceneInfo[]>;

export async function hotScenes(daoCache: DAOCache, contentClient: SmartContentClient, req: Request, res: Response) {
  // Method: GET
  // Path: /hot-scenes

  if (!hotSceneCache) {
    hotSceneCache = new TimeRefreshedDataHolder(() => fetchHotScenesData(daoCache, contentClient), ms("1m"));
  }

  const hotScenesData = await hotSceneCache.get();

  res.status(200).send(hotScenesData);
}

async function fetchRealmsData(daoCache: DAOCache): Promise<RealmInfo[]> {
  const statuses = await fetchCatalystStatuses(daoCache);

  return statuses
    .flatMap((server) =>
      server.layers.map((layer) => ({
        serverName: server.name,
        url: server.url,
        layer: layer.name,
        usersCount: layer.usersCount,
        usersMax: layer.maxUsers,
        userParcels: layer.usersParcels,
      }))
    )
    .sort((realm1, realm2) => realm2.usersCount - realm1.usersCount);
}

async function fetchHotScenesData(daoCache: DAOCache, contentClient: SmartContentClient): Promise<HotSceneInfo[]> {
  const statuses = await fetchCatalystStatuses(daoCache);
  const tiles = getOccupiedTiles(statuses);

  if (tiles.length > 0) {
    const scenes = await contentClient.fetchEntitiesByPointers(EntityType.SCENE as any, tiles);

    const hotScenes: HotSceneInfo[] = scenes.map(getHotSceneRecordFor);

    countUsers(hotScenes, statuses);

    const value = hotScenes.sort((scene1, scene2) => scene2.usersTotalCount - scene1.usersTotalCount);

    return value;
  } else {
    return [];
  }
}

async function fetchCatalystStatuses(daoCache: DAOCache) {
  const nodes = await daoCache.getServers();
  const statuses = await fetchStatuses(nodes);
  return statuses;
}

function countUsers(hotScenes: HotSceneInfo[], statuses: ServerStatus[]) {
  statuses.forEach((server) =>
    server.layers.forEach((layer) => {
      layer.usersParcels.forEach((parcel) => countUser(parcel, server, layer, hotScenes));
    })
  );
}

function countUser(parcel: ParcelCoord, server: ServerStatus, layer: Layer, hotScenes: HotSceneInfo[]) {
  const scene = hotScenes.find((it) => it.parcels?.some((sceneParcel) => parcelEqual(parcel, sceneParcel)));
  if (scene) {
    scene.usersTotalCount += 1;
    let realm = scene.realms.find((it) => it.serverName === server.name && it.layer === layer.name);
    if (!realm) {
      realm = {
        serverName: server.name,
        layer: layer.name,
        usersCount: 0,
        usersMax: layer.maxUsers,
        userParcels: [],
      };
      scene.realms.push(realm);
    }
    realm.usersCount += 1;
    realm.userParcels.push(parcel);
  }
}

function getOccupiedTiles(statuses: ServerStatus[]) {
  return [...new Set(statuses.flatMap((it) => it.layers.flatMap((layer) => layer.usersParcels.map((parcel) => `${parcel[0]},${parcel[1]}`))))];
}

function getHotSceneRecordFor(scene: Entity): HotSceneInfo {
  return {
    id: scene.id,
    name: scene.metadata?.display?.title,
    baseCoords: getCoords(scene.metadata?.scene.base),
    usersTotalCount: 0,
    parcels: scene.metadata?.scene.parcels.map(getCoords),
    thumbnail: scene.metadata?.display?.navmapThumbnail,
    creator: scene.metadata?.contact?.name,
    projectId: scene.metadata?.source?.projectId,
    description: scene.metadata?.display?.description,
    realms: [],
  };
}

function parcelEqual(parcel1: ParcelCoord, parcel2: ParcelCoord) {
  return parcel1[0] === parcel2[0] && parcel1[1] === parcel2[1];
}

function getCoords(coordsAsString: string): ParcelCoord {
  return coordsAsString.split(",").map((part) => parseInt(part, 10)) as ParcelCoord;
}

async function fetchStatuses(nodes: Set<ServerMetadata>): Promise<ServerStatus[]> {
  return (await Promise.all([...nodes].map((it) => fetchStatus(it)))).filter((it) => it[0] !== "rejected").map((it) => it[1]);
}

async function fetchStatus(serverData: ServerMetadata) {
  // TODO: Create a CommsClient and replace this plain json call
  const fetcher = new Fetcher();
  return noReject(fetcher.fetchJson(`${serverData.address}/comms/status?includeLayers=true`, { timeout: "10s" }).then((value) => ({ ...value, url: serverData.address })));
}