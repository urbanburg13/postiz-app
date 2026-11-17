import 'reflect-metadata';

const youtubeApi = {
  playlists: { list: jest.fn() },
  playlistItems: { list: jest.fn(), insert: jest.fn() },
};

jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
    youtube: jest.fn(() => youtubeApi),
    oauth2: jest.fn(),
    youtubeAnalytics: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { YoutubeProvider } from './youtube.provider';
// eslint-disable-next-line import/first
import {
  BadBody,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
// eslint-disable-next-line import/first
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';
// eslint-disable-next-line import/first
import { validate } from 'class-validator';

describe('YoutubeProvider playlists', () => {
  const provider = new YoutubeProvider() as any;

  beforeEach(() => jest.clearAllMocks());

  it('exposes getPlaylists as an integration tool', () => {
    const tools = Reflect.getMetadata('custom:tool', YoutubeProvider.prototype);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ methodName: 'getPlaylists' }),
      ])
    );
  });

  it('lists every playlist of the channel across pages', async () => {
    youtubeApi.playlists.list
      .mockResolvedValueOnce({
        data: {
          items: [{ id: 'PL1', snippet: { title: 'One' }, status: { privacyStatus: 'public' } }],
          nextPageToken: 'next',
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: 'PL2', snippet: { title: 'Two' } }] },
      });
    expect(await provider.getPlaylists('token')).toEqual([
      { id: 'PL1', name: 'One', privacy: 'public' },
      { id: 'PL2', name: 'Two', privacy: '' },
    ]);
  });

  it('maps an expired token on getPlaylists to RefreshToken', async () => {
    youtubeApi.playlists.list.mockRejectedValue({ response: { status: 401, data: {} } });
    await expect(provider.getPlaylists('expired')).rejects.toBeInstanceOf(RefreshToken);
  });

  it('does not insert a video that is already in the playlist', async () => {
    youtubeApi.playlistItems.list.mockResolvedValue({ data: { items: [{ id: 'x' }] } });
    expect(await provider.ensurePlaylistMembership('token', 'PL1', 'vid')).toBe(false);
    expect(youtubeApi.playlistItems.insert).not.toHaveBeenCalled();
  });

  it('adds a missing video to the playlist exactly once', async () => {
    youtubeApi.playlistItems.list.mockResolvedValue({ data: { items: [] } });
    youtubeApi.playlistItems.insert.mockResolvedValue({ data: { id: 'item' } });
    expect(await provider.ensurePlaylistMembership('token', 'PL1', 'vid')).toBe(true);
    expect(youtubeApi.playlistItems.insert).toHaveBeenCalledTimes(1);
    expect(youtubeApi.playlistItems.insert.mock.calls[0][0].requestBody.snippet).toEqual({
      playlistId: 'PL1',
      resourceId: { kind: 'youtube#video', videoId: 'vid' },
    });
  });

  it('rejects a playlist that belongs to another channel', async () => {
    youtubeApi.playlists.list.mockResolvedValue({
      data: { items: [{ id: 'PL1', snippet: { channelId: 'other' } }] },
    });
    await expect(provider.validateOwnedPlaylist('token', 'PL1', 'mine')).rejects.toBeInstanceOf(BadBody);
  });

  it('accepts a playlist of the connected channel', async () => {
    youtubeApi.playlists.list.mockResolvedValue({
      data: { items: [{ id: 'PL1', snippet: { channelId: 'mine' } }] },
    });
    await expect(provider.validateOwnedPlaylist('token', 'PL1', 'mine')).resolves.toBeUndefined();
  });

  it('keeps the video in checkPostStatus "ready" when only a playlist is left to do', async () => {
    jest.spyOn(provider, 'probeUploadSession').mockResolvedValue({ videoId: 'vid' });
    const result = await provider.checkPostStatus(
      'token',
      { uploadUri: 'u', videoSize: 1, path: 'p', uploadedBytes: 1, thumbnail: '', playlistId: 'PL1' },
      {} as any
    );
    expect(result).toMatchObject({ status: 'ready', pendingData: { videoId: 'vid', playlistId: 'PL1' } });
  });

  it('completes right away when there is neither a thumbnail nor a playlist', async () => {
    jest.spyOn(provider, 'probeUploadSession').mockResolvedValue({ videoId: 'vid' });
    const result = await provider.checkPostStatus(
      'token',
      { uploadUri: 'u', videoSize: 1, path: 'p', uploadedBytes: 1, thumbnail: '' },
      {} as any
    );
    expect(result).toMatchObject({ status: 'completed', postId: 'vid' });
  });

  it('adds the published video to the playlist when finalizing', async () => {
    const spy = jest.spyOn(provider, 'ensurePlaylistMembership').mockResolvedValue(true);
    const result = await provider.finalizePost(
      'token',
      { uploadUri: 'u', videoSize: 1, path: 'p', uploadedBytes: 1, thumbnail: '', playlistId: 'PL1', videoId: 'vid' },
      {} as any
    );
    expect(spy).toHaveBeenCalledWith('token', 'PL1', 'vid');
    expect(result).toMatchObject({ status: 'completed', postId: 'vid' });
  });

  it('accepts playlistId in the YouTube settings and keeps it optional', async () => {
    const base = { title: 'T', type: 'private' };
    const withPlaylist = Object.assign(new YoutubeSettingsDto(), { ...base, playlistId: 'PL1' });
    const without = Object.assign(new YoutubeSettingsDto(), base);
    expect(await validate(withPlaylist)).toEqual([]);
    expect(await validate(without)).toEqual([]);
  });
});
