import React, { useState, useEffect } from 'react';
import { useAuth } from '../lib/AuthContext';
import { ALL_MENU_ITEMS, UserRole } from '../lib/auth';
import { Users, Shield, CheckCircle2, Trash2, Plus, Key, X, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export const UserManagement: React.FC = () => {
  const { users, updateUserPermissions, addUser, deleteUser, updateUserPassword, currentUser, refreshUsers } = useAuth();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // [Task] Fetch users on mount to ensure real-time sync from Cloud DB
  useEffect(() => {
    refreshUsers();
  }, []);

  const handleToggleMenu = async (userId: string, menuId: string, currentMenus: string[], userRole: string) => {
    // ADMIN 권한 보호: ADMIN 계정은 스스로 권한을 해제할 수 없도록 보호
    if (userRole === 'ADMIN') return;

    let newMenus;
    if (currentMenus.includes(menuId)) {
      newMenus = currentMenus.filter(id => id !== menuId);
    } else {
      newMenus = [...currentMenus, menuId];
    }
    await updateUserPermissions(userId, newMenus);
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = newUserId.trim().toLowerCase();
    const cleanName = newUserName.trim();
    const cleanPw = newUserPassword.trim();
    
    if (!cleanId || !cleanName || !cleanPw) return;

    const success = await addUser({
      id: cleanId,
      name: cleanName,
      password: cleanPw,
      role: 'USER' as UserRole,
      allowedMenus: ['product'] // 기본값
    });

    if (success) {
      setNewUserId('');
      setNewUserName('');
      setNewUserPassword('');
      setIsAddModalOpen(false);
    } else {
      alert('사용자 추가에 실패했습니다. 중복된 ID인지 확인해 주세요.');
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPw = newPassword.trim();
    if (!cleanPw) return;

    const success = await updateUserPassword(targetUserId, cleanPw);
    if (success) {
      alert('비밀번호가 성공적으로 변경되었습니다.');
      setNewPassword('');
      setTargetUserId('');
      setIsPasswordModalOpen(false);
    } else {
      alert('비밀번호 변경에 실패했습니다. 에러를 확인해 주세요.');
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="text-black" />
            사용자 권한 관리
          </h1>
          <p className="text-gray-500 mt-1">시스템 사용자의 계정 및 메뉴 접근 권한을 설정할 수 있습니다.</p>
        </div>
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="flex items-center gap-2 bg-black text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-gray-800 transition-all shadow-lg shadow-black/10"
        >
          <Plus size={18} />
          사용자 추가
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-4 text-sm font-bold text-gray-600">사용자 이름 / ID</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-600">역할</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-600">허용된 메뉴</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-600 text-right">관리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(user => (
              <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-5">
                  <div className="font-bold text-gray-900">{user.name}</div>
                  <div className="text-xs text-gray-400">{user.id}</div>
                </td>
                <td className="px-6 py-5">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                    user.role === 'ADMIN' ? 'bg-black text-white' : 'bg-gray-100 text-gray-600'
                  }`}>
                    <Shield size={12} />
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-5">
                  <div className="flex flex-wrap gap-4">
                    {ALL_MENU_ITEMS.map(menu => {
                      const isMenuChecked = user.role === 'ADMIN' ? true : user.allowedMenus.includes(menu.id);
                      return (
                        <label 
                          key={menu.id} 
                          className={`flex items-center gap-2 group ${user.role === 'ADMIN' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          <div 
                            className="relative"
                            onClick={() => handleToggleMenu(user.id, menu.id, user.allowedMenus, user.role)}
                          >
                            <input 
                              type="checkbox"
                              checked={isMenuChecked}
                              readOnly
                              disabled={user.role === 'ADMIN'}
                              className="sr-only"
                            />
                            <div className={`w-5 h-5 rounded border transition-all flex items-center justify-center ${
                              isMenuChecked 
                                ? 'bg-black border-black text-white' 
                                : 'bg-white border-gray-300 group-hover:border-gray-400'
                            } ${user.role === 'ADMIN' ? 'opacity-80' : ''}`}>
                              {isMenuChecked ? <CheckCircle2 size={14} /> : <div className="w-1 h-1 bg-transparent rounded-full" />}
                            </div>
                          </div>
                          <span className={`text-sm ${user.role === 'ADMIN' ? 'text-gray-500 font-medium' : 'text-gray-700'}`}>{menu.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </td>
                <td className="px-6 py-5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setTargetUserId(user.id);
                        setIsPasswordModalOpen(true);
                      }}
                      className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                      title="비밀번호 변경"
                    >
                      <Key size={18} />
                    </button>
                    {user.role !== 'ADMIN' && (
                      <button
                        onClick={async () => {
                          if (confirm(`${user.name} 사용자를 삭제하시겠습니까?`)) {
                            const success = await deleteUser(user.id);
                            if (!success) {
                              alert('사용자 삭제에 실패했습니다.');
                            }
                          }
                        }}
                        className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                        title="사용자 삭제"
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 p-4 bg-amber-50 rounded-xl border border-amber-100 flex items-start gap-3">
        <Shield className="text-amber-500 mt-0.5" size={18} />
        <div className="text-xs text-amber-700 leading-relaxed">
          <strong>보안 안내:</strong> 관리자(ADMIN) 계정은 시스템 보호를 위해 모든 메뉴 권한이 고정되어 있습니다. 
          일반 사용자 삭제는 즉시 반영되며 복구할 수 없습니다. 
          관리자 본인의 비밀번호 변경 시에도 환경변수(`VITE_ADMIN_PASSWORD`) 설정보다 현재 시스템상의 변경된 값이 우선 적용됩니다.
        </div>
      </div>

      {/* Add User Modal */}
      <AnimatePresence>
        {isAddModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-bold text-gray-900">새 사용자 추가</h3>
                <button onClick={() => setIsAddModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleAddUser} className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">아이디</label>
                  <input
                    type="text"
                    value={newUserId}
                    onChange={(e) => setNewUserId(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black outline-none text-sm"
                    placeholder="User ID"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">이름</label>
                  <input
                    type="text"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black outline-none text-sm"
                    placeholder="사용자 이름"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">비밀번호</label>
                  <input
                    type="password"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black outline-none text-sm"
                    placeholder="초기 비밀번호"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-3 bg-black text-white rounded-xl font-bold hover:bg-gray-800 transition-all flex items-center justify-center gap-2"
                >
                  <Check size={18} />
                  사용자 생성
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Change Password Modal */}
      <AnimatePresence>
        {isPasswordModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsPasswordModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-bold text-gray-900">비밀번호 변경</h3>
                <button onClick={() => setIsPasswordModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleUpdatePassword} className="p-6 space-y-4">
                <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-xl mb-4">
                  <p className="text-[11px] text-indigo-700">
                    대상을 선택했습니다: <strong>{users.find(u => u.id === targetUserId)?.name}</strong>
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">새 비밀번호</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black outline-none text-sm"
                    placeholder="새로운 비밀번호를 입력하세요"
                    required
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-3 bg-black text-white rounded-xl font-bold hover:bg-gray-800 transition-all flex items-center justify-center gap-2"
                >
                  <Check size={18} />
                  비밀번호 업데이트
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
